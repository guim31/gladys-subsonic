// -----------------------------------------------------------------------------
// Device type: JUKEBOX
// Controls the server-side jukebox: the music plays on the machine hosting the
// Subsonic server (`jukeboxControl` endpoint). The feature must be enabled on
// the server itself — in Navidrome: `Jukebox.Enabled = true` (and an audio
// output on the host). The device is only created when the user turns on the
// `jukebox_enabled` toggle in the integration configuration.
//
// Features (Gladys `music` category):
//   - play / pause / previous / next : momentary commands;
//   - volume                         : 0-100, mapped to the jukebox gain 0.0-1.0;
//   - playback state                 : read-only, 1 = playing (polled).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { jukeboxControl, getRandomSongs, getPlaylists, getPlaylist, asArray } from '../subsonic.js';
import { isConfigured, pollFrequencyMs } from '../config.js';
import { serverPlatformId } from './server.js';
import { JUKEBOX_ACTION, RANDOM_SONG_COUNT } from '../widgets.js';

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
};
const FEATURE = JUKEBOX_FEATURE;

export const jukebox = {
  key: DEVICE_TYPE,

  // The device only exists when the user opted in (the jukebox also has to be
  // enabled server-side, which we cannot detect without triggering errors).
  enabled(config) {
    return config.jukebox_enabled;
  },

  deviceExternalId(gladys, config) {
    return gladys.externalIds(DEVICE_TYPE, serverPlatformId(config)).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
    const command = (name, key, type) => ({
      name,
      external_id: ids.feature(key),
      category: DEVICE_FEATURE_CATEGORIES.MUSIC,
      type,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    });
    return {
      name: 'Subsonic jukebox',
      external_id: ids.device,
      // Both are required for Gladys to poll us: see server.js.
      should_poll: true,
      poll_frequency: pollFrequencyMs(config),
      features: [
        command('Play', FEATURE.PLAY, DEVICE_FEATURE_TYPES.MUSIC.PLAY),
        command('Pause', FEATURE.PAUSE, DEVICE_FEATURE_TYPES.MUSIC.PAUSE),
        command('Previous', FEATURE.PREVIOUS, DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS),
        command('Next', FEATURE.NEXT, DEVICE_FEATURE_TYPES.MUSIC.NEXT),
        {
          name: 'Volume',
          external_id: ids.feature(FEATURE.VOLUME),
          category: DEVICE_FEATURE_CATEGORIES.MUSIC,
          type: DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
          min: 0,
          max: 100,
          read_only: false,
          has_feedback: true,
          keep_history: false,
        },
        {
          name: 'Playback state',
          external_id: ids.feature(FEATURE.PLAYBACK_STATE),
          category: DEVICE_FEATURE_CATEGORIES.MUSIC,
          type: DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE,
          min: 0,
          max: 1,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  async onSetValue(gladys, { feature, value, config }) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));

    switch (feature.type) {
      case DEVICE_FEATURE_TYPES.MUSIC.PLAY: {
        await jukeboxControl(config, 'start');
        await gladys.publishState(ids.feature(FEATURE.PLAYBACK_STATE), 1);
        return;
      }
      case DEVICE_FEATURE_TYPES.MUSIC.PAUSE: {
        // The jukebox "stop" keeps the position: it behaves as a pause.
        await jukeboxControl(config, 'stop');
        await gladys.publishState(ids.feature(FEATURE.PLAYBACK_STATE), 0);
        return;
      }
      case DEVICE_FEATURE_TYPES.MUSIC.NEXT:
      case DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS: {
        await skipQueue(config, feature.type === DEVICE_FEATURE_TYPES.MUSIC.NEXT ? 1 : -1);
        return;
      }
      case DEVICE_FEATURE_TYPES.MUSIC.VOLUME: {
        const gain = Math.min(Math.max(Number(value) / 100, 0), 1);
        const status = await jukeboxControl(config, 'setGain', { gain });
        // has_feedback = true -> publish the value confirmed by the server.
        const confirmed = status.gain !== undefined ? Math.round(status.gain * 100) : value;
        await gladys.publishState(feature.external_id, confirmed);
        return;
      }
      default:
        throw new Error(`Jukebox: unsupported command ${feature.type}`);
    }
  },

  // Buttons of the jukebox dashboard widget (hoisted, see below).
  widgetAction,

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
    const status = await jukeboxControl(config, 'status');
    logger.debug(`Jukebox status: playing=${status.playing} gain=${status.gain}`);

    const states = [
      {
        device_feature_external_id: ids.feature(FEATURE.PLAYBACK_STATE),
        state: status.playing ? 1 : 0,
      },
    ];
    if (status.gain !== undefined) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.VOLUME),
        state: Math.round(status.gain * 100),
      });
    }
    await gladys.publishStates(states);
  },

  actions: {
    async jukebox_play_random(_gladys, { fields, config }) {
      const guard = jukeboxGuard(config);
      if (guard) {
        return guard;
      }
      const count = Math.min(Math.max(Number(fields?.count) || RANDOM_SONG_COUNT, 1), 500);
      logger.info(`Action jukebox_play_random -> queuing ${count} random songs`);
      const { queued } = await playRandom(config, count);
      return randomMessage(queued);
    },

    async jukebox_play_playlist(_gladys, { fields, config }) {
      const guard = jukeboxGuard(config);
      if (guard) {
        return guard;
      }
      const wanted = String(fields?.playlist ?? '').trim();
      if (!wanted) {
        return { en: 'Give the name of a playlist.', fr: "Indiquez le nom d'une playlist." };
      }
      logger.info(`Action jukebox_play_playlist -> "${wanted}"`);

      const playlists = await getPlaylists(config);
      const match = playlists.find((p) => p.name?.toLowerCase() === wanted.toLowerCase());
      if (!match) {
        const available = playlists.map((p) => p.name).join(', ') || 'none';
        return {
          en: `No playlist named "${wanted}". Available: ${available}.`,
          fr: `Aucune playlist nommée « ${wanted} ». Disponibles : ${available}.`,
        };
      }
      const playlist = await getPlaylist(config, match.id);
      if (playlist.entry.length === 0) {
        return {
          en: `The playlist "${match.name}" is empty.`,
          fr: `La playlist « ${match.name} » est vide.`,
        };
      }
      await jukeboxControl(config, 'clear');
      await jukeboxControl(config, 'add', { id: playlist.entry.map((song) => song.id) });
      await jukeboxControl(config, 'start');
      return {
        en: `Playing "${match.name}" (${playlist.entry.length} songs) on the jukebox.`,
        fr: `Lecture de « ${match.name} » (${playlist.entry.length} morceaux) sur le jukebox.`,
      };
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
    throw new Error('Jukebox not enabled. / Jukebox non activé.');
  }
  const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
  // The command already ran: a refused publication (the jukebox device was
  // never added to Gladys, so the core answers 4xx) must not turn a
  // successful tap into a red toast.
  const publishPlayback = async (status, expected) => {
    const state = typeof status?.playing === 'boolean' ? (status.playing ? 1 : 0) : expected;
    try {
      await gladys.publishState(ids.feature(FEATURE.PLAYBACK_STATE), state);
    } catch (err) {
      logger.warn(`Playback state not published after a widget action (${err.message})`);
    }
  };

  switch (actionKey) {
    case JUKEBOX_ACTION.TOGGLE: {
      // The content showed pause or play from the state at render time; the
      // state at tap time decides, so a stale card never does the opposite.
      const before = await jukeboxControl(config, 'status');
      const status = await jukeboxControl(config, before.playing ? 'stop' : 'start');
      await publishPlayback(status, before.playing ? 0 : 1);
      return undefined;
    }
    case JUKEBOX_ACTION.PREVIOUS:
    case JUKEBOX_ACTION.NEXT: {
      // `skip` moves to the track and starts playing it.
      const status = await skipQueue(config, actionKey === JUKEBOX_ACTION.NEXT ? 1 : -1);
      await publishPlayback(status, 1);
      return undefined;
    }
    case JUKEBOX_ACTION.RANDOM: {
      const { queued, status } = await playRandom(config, RANDOM_SONG_COUNT);
      if (queued > 0) {
        await publishPlayback(status, 1);
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
  await jukeboxControl(config, 'add', { id: songs.map((song) => song.id) });
  const status = await jukeboxControl(config, 'start');
  return { queued: songs.length, status };
}

/**
 * The message of a random playback, for the action and the widget alike.
 * @param {number} queued
 */
function randomMessage(queued) {
  if (queued === 0) {
    return {
      en: 'The library returned no songs.',
      fr: "La bibliothèque n'a renvoyé aucun morceau.",
    };
  }
  return {
    en: `Playing ${queued} random songs on the jukebox.`,
    fr: `Lecture de ${queued} morceaux aléatoires sur le jukebox.`,
  };
}

/**
 * Common pre-checks of the jukebox actions. Returns a user message when the
 * action cannot run, `null` when everything is ready.
 * @param {object} config
 */
function jukeboxGuard(config) {
  if (!isConfigured(config)) {
    return {
      en: 'Fill in the server URL, username and password first.',
      fr: "Renseignez d'abord l'URL du serveur, l'utilisateur et le mot de passe.",
    };
  }
  if (!config.jukebox_enabled) {
    return {
      en: 'Enable the jukebox in the integration configuration first (and on the server, e.g. Jukebox.Enabled in Navidrome).',
      fr: "Activez d'abord le jukebox dans la configuration de l'intégration (et côté serveur, ex. Jukebox.Enabled dans Navidrome).",
    };
  }
  return null;
}
