// -----------------------------------------------------------------------------
// Device type: JUKEBOX
// Controls the server-side jukebox: the music plays on the machine hosting the
// Subsonic server (`jukeboxControl` endpoint). The feature must be enabled on
// the server itself — in Navidrome: `Jukebox.Enabled = true` (and an audio
// output on the host). The device is only created when the user turns on the
// `jukebox_enabled` toggle in the integration configuration.
//
// It is the Gladys 5.3 music player of the integration (features of the
// `music` category, published through publishNowPlaying):
//   - play / pause / previous / next : momentary commands (kept from 1.x);
//   - volume                         : 0-100, mapped to the jukebox gain 0.0-1.0;
//   - playback state                 : PAUSED 0, PLAYING 1, IDLE 2 (empty
//     queue, or stopped by Gladys); writable: 0 pauses, 1 plays, 2 stops
//     (pause, back to the start of the song);
//   - title, artist, album, artwork, duration of the current song;
//   - position                       : writable, a write seeks (`skip` with
//     an offset).
// The API has no shuffle MODE (`shuffle` reorders the queue once), no repeat
// and no mute: none of them is published.
//
// The jukebox pushes nothing: it is polled. Each poll reads the small
// `status`; the queue (`get`, every song of it) only when the current index
// moved, after a command, or once a minute. While a song plays, one more
// read is scheduled right after its expected end, so a track change shows
// within seconds even with a 60 s poll.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  MUSIC_PLAYBACK_STATE,
} from '@gladysassistant/integration-sdk';
import { jukeboxControl, getRandomSongs, getPlaylists, getPlaylist, asArray } from '../subsonic.js';
import { isConfigured, pollFrequencyMs } from '../config.js';
import { serverPlatformId } from './server.js';
import { JUKEBOX_ACTION, RANDOM_SONG_COUNT } from '../widgets.js';
import { artworkSource, ARTWORK_SIZE, addSongs } from '../catalog.js';
import { TEXT, MESSAGES, thrown } from '../i18n.js';

const DEVICE_TYPE = 'jukebox';

const logger = createLogger({ name: DEVICE_TYPE });

/** Feature keys of the jukebox device (the `external_id` suffixes). */
export const JUKEBOX_FEATURE = {
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  VOLUME: 'volume',
  PLAYBACK_STATE: 'playback-state',
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
};
const FEATURE = JUKEBOX_FEATURE;

/** Bound of the duration and position features, in seconds. */
export const MAX_SECONDS = 86_400;

/** The queue is read again at least this often while the index stays (a
 * change by another client; ours read it at once). */
export const QUEUE_REFRESH_MS = 5 * 60 * 1000;

/** Margin after the expected end of a song before reading the jukebox. */
const TRACK_END_MARGIN_MS = 1500;

// The last queue read (`get`), for the server it was read from.
let queueCache = null;
// Set when Gladys stopped the jukebox (paused at the start of the song), or
// when the queue played to its end: the jukebox itself only knows "not
// playing", this tells IDLE from PAUSED until it plays again, moves, or
// another song is current.
let stoppedAt = null;
// Was the jukebox playing at the last read (to see the queue end)?
let lastRead = null;
// The read scheduled after the expected end of the current song.
let trackEndTimer = null;
// How to read the jukebox again (set by index.js: a poll of the device).
let followUp = null;
// The publication in progress (they run one after the other).
let publishing = Promise.resolve();

/** Wire the read run after the expected end of a song. */
export function setJukeboxFollowUp(callback) {
  followUp = callback;
}

/** Forget the queue, the stop and the timer (tests, shutdown). */
export function resetJukeboxState() {
  queueCache = null;
  stoppedAt = null;
  lastRead = null;
  clearTimeout(trackEndTimer);
  trackEndTimer = null;
}

const ids = (gladys, config) => gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));

/** The external ids that differ from publishNowPlaying's `${device}:${type}`. */
function nowPlayingFeatureIds(deviceIds) {
  return { playback_state: deviceIds.feature(FEATURE.PLAYBACK_STATE) };
}

/** Is the jukebox device added to Gladys (else the core drops its states)? */
function isCreated(gladys, config) {
  const id = ids(gladys, config).device;
  return (gladys.devices ?? []).some((device) => device.external_id === id);
}

const seconds = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_SECONDS) : 0;
};

/**
 * Read the jukebox (unless a command just answered its status) and publish
 * what it plays through publishNowPlaying, which sends only what changed.
 * @param {object} gladys
 * @param {object} config
 * @param {{ status?: object, fresh?: boolean }} [options] `status`: the
 *   jukeboxStatus a command answered; `fresh`: read the queue again
 */
export function publishJukebox(gladys, config, options = {}) {
  // One at a time: a poll, a command and the read after a song share the
  // queue and the stop memory, and the last read must be the last published.
  const run = publishing.then(() => readAndPublish(gladys, config, options));
  publishing = run.catch(() => {});
  return run;
}

async function readAndPublish(gladys, config, { status, fresh = false }) {
  const platform = serverPlatformId(config);
  let current = status ?? (await jukeboxControl(config, 'status'));
  let index = Number(current.currentIndex);
  const stale =
    fresh ||
    queueCache === null ||
    queueCache.platform !== platform ||
    queueCache.currentIndex !== index ||
    Date.now() - queueCache.at >= QUEUE_REFRESH_MS ||
    (index >= 0 && queueCache.entries[index] === undefined);
  if (stale) {
    // The queue carries the status too, read at the same instant.
    current = await jukeboxControl(config, 'get');
    index = Number(current.currentIndex);
    queueCache = {
      platform,
      at: Date.now(),
      currentIndex: index,
      entries: asArray(current.entry),
    };
  }
  const entry = index >= 0 ? queueCache.entries[index] : undefined;
  const playing = current.playing === true;
  const position = seconds(current.position);
  if (
    stoppedAt !== null &&
    (stoppedAt.platform !== platform || playing || stoppedAt.index !== index || position > 0)
  ) {
    stoppedAt = null;
  }
  // The queue played to its end: Navidrome closes the last song (position
  // 0, not playing) and keeps it current. Nothing else turns a playing
  // jukebox into that without a command (a pause keeps the position; the
  // reads after a command are `fresh`, never taken for an end).
  if (
    !fresh &&
    lastRead?.playing &&
    lastRead.platform === platform &&
    !playing &&
    position === 0 &&
    entry !== undefined &&
    index === queueCache.entries.length - 1
  ) {
    stoppedAt = { platform, index };
  }
  lastRead = { platform, playing };

  const snapshot = {};
  if (current.gain !== undefined && current.gain !== null) {
    snapshot.volume = Math.min(Math.max(Math.round(Number(current.gain) * 100), 0), 100);
  }
  if (!entry) {
    Object.assign(snapshot, {
      playback_state: MUSIC_PLAYBACK_STATE.IDLE,
      title: '',
      artist: '',
      album: '',
      artwork_url: null,
      duration: 0,
      position: 0,
    });
  } else {
    let state = MUSIC_PLAYBACK_STATE.PAUSED;
    if (playing) {
      state = MUSIC_PLAYBACK_STATE.PLAYING;
    } else if (stoppedAt !== null) {
      state = MUSIC_PLAYBACK_STATE.IDLE;
    }
    Object.assign(snapshot, {
      playback_state: state,
      title: String(entry.title ?? ''),
      artist: String(entry.artist ?? entry.displayArtist ?? ''),
      album: String(entry.album ?? ''),
      artwork_url: entry.coverArt
        ? artworkSource(platform, String(entry.coverArt), ARTWORK_SIZE.player)
        : null,
      duration: seconds(entry.duration),
      position,
    });
  }
  logger.debug(
    `Jukebox: index=${index} playing=${playing} position=${position} gain=${current.gain}`,
  );
  const deviceIds = ids(gladys, config);
  await gladys.publishNowPlaying(deviceIds.device, snapshot, {
    featureExternalIds: nowPlayingFeatureIds(deviceIds),
  });
  scheduleTrackEnd(config, playing && entry ? seconds(entry.duration) - position : null);
}

/**
 * Read the jukebox again right after the current song should end, when
 * that comes before the next poll.
 * @param {object} config
 * @param {number|null} remaining seconds left in the playing song
 */
function scheduleTrackEnd(config, remaining) {
  clearTimeout(trackEndTimer);
  trackEndTimer = null;
  if (followUp === null || remaining === null || !(remaining >= 0)) {
    return;
  }
  const delay = remaining * 1000 + TRACK_END_MARGIN_MS;
  if (delay >= pollFrequencyMs(config)) {
    return;
  }
  trackEndTimer = setTimeout(() => {
    trackEndTimer = null;
    Promise.resolve()
      .then(() => followUp())
      .catch((err) => logger.debug(`Jukebox read after the song failed: ${err.message}`));
  }, delay);
  trackEndTimer.unref?.();
}

/**
 * Publish after a command from a widget or an action: only when the device
 * is added to Gladys, and never failing the command that already ran.
 */
async function publishAfterCommand(gladys, config, status) {
  if (!isCreated(gladys, config)) {
    return;
  }
  try {
    await publishJukebox(gladys, config, { status, fresh: true });
  } catch (err) {
    logger.warn(`Jukebox state not published after a command (${err.message})`);
  }
}

/**
 * Write of the playback state: 1 plays, 0 pauses, 2 stops (a pause back at
 * the start of the song, shown IDLE until the jukebox moves).
 * @returns {Promise<object>} the jukebox status
 */
async function setPlaybackState(config, value) {
  if (value === MUSIC_PLAYBACK_STATE.PLAYING) {
    return jukeboxControl(config, 'start');
  }
  if (value === MUSIC_PLAYBACK_STATE.PAUSED) {
    // Stopped or at the end of the queue: now paused, as asked.
    stoppedAt = null;
    return jukeboxControl(config, 'stop');
  }
  if (value === MUSIC_PLAYBACK_STATE.IDLE) {
    const status = await jukeboxControl(config, 'stop');
    const index = Number(status.currentIndex);
    if (!(index >= 0)) {
      return status;
    }
    const rewound = await jukeboxControl(config, 'skip', { index, offset: 0 });
    stoppedAt = { platform: serverPlatformId(config), index };
    return rewound;
  }
  throw new Error(thrown(TEXT.badPlaybackState));
}

/**
 * Write of the position: a seek in the current song.
 * @returns {Promise<object>} the jukebox status
 */
async function seek(config, value) {
  const status = await jukeboxControl(config, 'status');
  const index = Number(status.currentIndex);
  if (!(index >= 0)) {
    throw new Error(thrown(TEXT.nothingLoaded));
  }
  return jukeboxControl(config, 'skip', { index, offset: seconds(value) });
}

export const jukebox = {
  key: DEVICE_TYPE,

  // The device only exists when the user opted in (the jukebox also has to be
  // enabled server-side, which we cannot detect without triggering errors).
  enabled(config) {
    return config.jukebox_enabled;
  },

  deviceExternalId(gladys, config) {
    return ids(gladys, config).device;
  },

  buildDevice(gladys, config) {
    const deviceIds = ids(gladys, config);
    const feature = (name, key, type, extra) => ({
      name,
      external_id: deviceIds.feature(key),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...extra,
    });
    // Read-only string state (min/max are NOT NULL in the core database).
    const text = (name, key, type) =>
      feature(name, key, type, { max: 0, read_only: true, has_feedback: false });
    const TYPES = DEVICE_FEATURE_TYPES.MUSIC;
    return {
      name: 'Subsonic jukebox',
      external_id: deviceIds.device,
      // Both are required for Gladys to poll us: see server.js.
      should_poll: true,
      poll_frequency: pollFrequencyMs(config),
      features: [
        feature('Play', FEATURE.PLAY, TYPES.PLAY),
        feature('Pause', FEATURE.PAUSE, TYPES.PAUSE),
        feature('Previous', FEATURE.PREVIOUS, TYPES.PREVIOUS),
        feature('Next', FEATURE.NEXT, TYPES.NEXT),
        feature('Volume', FEATURE.VOLUME, TYPES.VOLUME, { max: 100, has_feedback: true }),
        // Read-only 0/1 before 1.3.0: same external id, the "Update" of the
        // Discover tab makes it writable with IDLE.
        feature('Playback state', FEATURE.PLAYBACK_STATE, TYPES.PLAYBACK_STATE, {
          max: MUSIC_PLAYBACK_STATE.IDLE,
          has_feedback: true,
        }),
        text('Title', FEATURE.TITLE, TYPES.TITLE),
        text('Artist', FEATURE.ARTIST, TYPES.ARTIST),
        text('Album', FEATURE.ALBUM, TYPES.ALBUM),
        text('Artwork', FEATURE.ARTWORK, TYPES.ARTWORK),
        feature('Duration', FEATURE.DURATION, TYPES.DURATION, {
          unit: DEVICE_FEATURE_UNITS.SECONDS,
          max: MAX_SECONDS,
          read_only: true,
        }),
        feature('Position', FEATURE.POSITION, TYPES.POSITION, {
          unit: DEVICE_FEATURE_UNITS.SECONDS,
          max: MAX_SECONDS,
          has_feedback: true,
        }),
      ],
    };
  },

  async onSetValue(gladys, { feature, value, config }) {
    const TYPES = DEVICE_FEATURE_TYPES.MUSIC;
    let status;
    switch (feature.type) {
      case TYPES.PLAY:
        status = await jukeboxControl(config, 'start');
        break;
      case TYPES.PAUSE:
        // The jukebox "stop" keeps the position: it behaves as a pause.
        status = await jukeboxControl(config, 'stop');
        break;
      case TYPES.PLAYBACK_STATE:
        status = await setPlaybackState(config, Number(value));
        break;
      case TYPES.POSITION:
        status = await seek(config, value);
        break;
      case TYPES.NEXT:
      case TYPES.PREVIOUS:
        status = await skipQueue(config, feature.type === TYPES.NEXT ? 1 : -1);
        break;
      case TYPES.VOLUME: {
        const gain = Math.min(Math.max(Number(value) / 100, 0), 1);
        status = await jukeboxControl(config, 'setGain', {
          gain: Number.isFinite(gain) ? gain : 0,
        });
        break;
      }
      default:
        throw new Error(`Jukebox: unsupported command ${feature.type}`);
    }
    // has_feedback: what the jukebox answered, read at once.
    await publishJukebox(gladys, config, { status, fresh: true });
  },

  // Buttons of the jukebox dashboard widget (hoisted, see below).
  widgetAction,

  async onPoll(gladys, config) {
    await publishJukebox(gladys, config);
  },

  // A forced poll (connection, new config, device added or updated): send
  // everything again, from a fresh queue.
  forgetPublished(gladys, config) {
    queueCache = null;
    if (gladys && config) {
      gladys.forgetPublishedStates?.(ids(gladys, config).device);
    }
  },

  actions: {
    async jukebox_play_random(gladys, { fields, config }) {
      const guard = jukeboxGuard(config);
      if (guard) {
        return guard;
      }
      const count = Math.min(Math.max(Number(fields?.count) || RANDOM_SONG_COUNT, 1), 500);
      logger.info(`Action jukebox_play_random -> queuing ${count} random songs`);
      const { queued, status } = await playRandom(config, count);
      if (queued > 0) {
        await publishAfterCommand(gladys, config, status);
      }
      return randomMessage(queued);
    },

    async jukebox_play_playlist(gladys, { fields, config }) {
      const guard = jukeboxGuard(config);
      if (guard) {
        return guard;
      }
      const wanted = String(fields?.playlist ?? '').trim();
      if (!wanted) {
        return TEXT.playlistMissing;
      }
      logger.info(`Action jukebox_play_playlist -> "${wanted}"`);

      const playlists = await getPlaylists(config);
      const match = playlists.find((p) => p.name?.toLowerCase() === wanted.toLowerCase());
      if (!match) {
        return MESSAGES.playlistNotFound(wanted, playlists.map((p) => p.name).join(', '));
      }
      const playlist = await getPlaylist(config, match.id);
      if (playlist.entry.length === 0) {
        return MESSAGES.playlistEmpty(match.name);
      }
      await jukeboxControl(config, 'clear');
      await addSongs(
        config,
        playlist.entry.map((song) => String(song.id)),
      );
      const status = await jukeboxControl(config, 'start');
      await publishAfterCommand(gladys, config, status);
      return MESSAGES.playingPlaylist(match.name, playlist.entry.length);
    },
  },
};

/**
 * A button of the jukebox widget was tapped: run the command, then publish
 * the playback state Gladys shows, as onSetValue does. Resolves the toast
 * message, when there is something to say.
 * @param {object} gladys
 * @param {{ actionKey: string, config: object }} input
 */
async function widgetAction(gladys, { actionKey, config }) {
  if (jukeboxGuard(config)) {
    // The widget itself tells the user what to enable: a tap that reaches
    // this point comes from a content built before the config changed. A
    // thrown message becomes a toast of 200 characters at most: keep it short.
    throw new Error(thrown(TEXT.jukeboxNotEnabled));
  }
  // The command already ran: a refused publication must not turn a
  // successful tap into a red toast (publishAfterCommand never throws).
  const publishPlayback = (status) => publishAfterCommand(gladys, config, status);

  switch (actionKey) {
    case JUKEBOX_ACTION.TOGGLE: {
      // The content showed pause or play from the state at render time; the
      // state at tap time decides, so a stale card never does the opposite.
      const before = await jukeboxControl(config, 'status');
      const status = await jukeboxControl(config, before.playing ? 'stop' : 'start');
      await publishPlayback(status);
      return undefined;
    }
    case JUKEBOX_ACTION.PREVIOUS:
    case JUKEBOX_ACTION.NEXT: {
      // `skip` moves to the track (Navidrome keeps playing or paused).
      const status = await skipQueue(config, actionKey === JUKEBOX_ACTION.NEXT ? 1 : -1);
      await publishPlayback(status);
      return undefined;
    }
    case JUKEBOX_ACTION.RANDOM: {
      const { queued, status } = await playRandom(config, RANDOM_SONG_COUNT);
      if (queued > 0) {
        await publishPlayback(status);
      }
      return randomMessage(queued);
    }
    default:
      throw new Error(`Unknown widget action ${actionKey}`);
  }
}

/**
 * Move the jukebox to the previous or next track of its queue.
 * @param {object} config
 * @param {1|-1} direction
 * @returns {Promise<object>} the jukebox status after the skip
 * @throws when the queue has no track in that direction
 */
export async function skipQueue(config, direction) {
  // `skip` needs the target index: read the queue first.
  const playlist = await jukeboxControl(config, 'get');
  const entries = asArray(playlist.entry);
  const current = playlist.currentIndex ?? 0;
  const target = current + direction;
  if (target < 0 || (entries.length > 0 && target >= entries.length)) {
    throw new Error(`No track at position ${target} in the jukebox queue`);
  }
  return jukeboxControl(config, 'skip', { index: target });
}

/**
 * Replace the jukebox queue with random songs and start playing.
 * @param {object} config
 * @param {number} count
 * @returns {Promise<{ queued: number, status: object|null }>} how many songs
 *   were queued (0 when the library returned none: the queue is untouched)
 *   and the jukebox status after the start
 */
export async function playRandom(config, count) {
  const songs = await getRandomSongs(config, count);
  if (songs.length === 0) {
    return { queued: 0, status: null };
  }
  await jukeboxControl(config, 'clear');
  await addSongs(
    config,
    songs.map((song) => String(song.id)),
  );
  const status = await jukeboxControl(config, 'start');
  return { queued: songs.length, status };
}

/**
 * The message of a random playback, for the action and the widget alike.
 * @param {number} queued
 */
function randomMessage(queued) {
  if (queued === 0) {
    return TEXT.noSongs;
  }
  return MESSAGES.playingRandom(queued);
}

/**
 * Common pre-checks of the jukebox actions. Returns a user message when the
 * action cannot run, `null` when everything is ready.
 * @param {object} config
 */
function jukeboxGuard(config) {
  if (!isConfigured(config)) {
    return TEXT.notConfiguredFirst;
  }
  if (!config.jukebox_enabled) {
    return TEXT.jukeboxDisabledFirst;
  }
  return null;
}
