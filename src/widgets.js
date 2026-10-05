// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+), content builders — pure functions.
//
//   - now_playing : the number of streams (a live tile bound to the server
//                   sensor) and one row per entry of the server's now playing
//                   list, with the cover, who listens and whether it really
//                   plays;
//   - jukebox     : the server-side jukebox as a remote: the cover and the
//                   title of the current track, its state, the volume, the
//                   position in the queue, and the play/pause, previous, next
//                   and shuffle buttons;
//   - library     : the three library counters (live tiles), the server
//                   identity, the scan status and a scan button.
//
// No network here: index.js gathers the data and passes it in, so every
// content can be built and validated in the tests. Covers are served by the
// integration (onWidgetGetImage): a content only carries image KEYS, handed
// out by the cover registry (src/covers.js) through the `register` callback.
//
// Gladys renders at most 8 components (1 focal, 6 tiles, 2 texts of which 1
// body, 1 status, 4 buttons) in a canonical order, and drops a button whose
// action key another one already uses. A state is told by the icon or a
// color, never by the `primary` button style, which dark mode paints like
// the others. Every text is a multi-language object: the core picks the
// user's language and falls back on `en`.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { isPlaying, asArray } from './subsonic.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = {
  NOW_PLAYING: 'now_playing',
  JUKEBOX: 'jukebox',
  LIBRARY: 'library',
};

/** Action keys of the jukebox widget buttons (relayed to onWidgetAction). */
export const JUKEBOX_ACTION = {
  TOGGLE: 'toggle',
  PREVIOUS: 'previous',
  NEXT: 'next',
  RANDOM: 'random',
};

/** Action keys of the library widget buttons. */
export const LIBRARY_ACTION = {
  SCAN: 'scan',
};

/** Songs queued by the shuffle button, like the default of the scene action. */
export const RANDOM_SONG_COUNT = 20;

// Freshness of each content, in seconds (the core re-pulls past it).
export const TTL = {
  NOW_PLAYING: 30,
  JUKEBOX: 30,
  LIBRARY: 900,
  // While a scan runs the counters move: follow it closely.
  LIBRARY_SCANNING: 10,
  // The widget cannot work until the user fixes something: no hurry.
  MESSAGE: 300,
};

// Gladys shows 8 rows of a `list` card-list at most.
const MAX_LIST_ITEMS = 8;

const T = {
  streams: { en: 'Streams', fr: 'Lectures' },
  nothingPlaying: { en: 'Nothing is playing right now.', fr: 'Rien en écoute.' },
  unknownTrack: { en: 'Unknown track', fr: 'Morceau inconnu' },
  jukeboxDisabled: {
    en: 'Enable the jukebox in the integration configuration.',
    fr: "Activez le jukebox dans la configuration de l'intégration.",
  },
  emptyQueue: { en: 'Empty queue', fr: 'File vide' },
  state: { en: 'State', fr: 'État' },
  playing: { en: 'Playing', fr: 'Lecture' },
  stopped: { en: 'Stopped', fr: 'Arrêt' },
  volume: { en: 'Volume', fr: 'Volume' },
  queue: { en: 'Queue', fr: 'File' },
  play: { en: 'Play', fr: 'Lecture' },
  pause: { en: 'Pause', fr: 'Pause' },
  previous: { en: 'Previous', fr: 'Précédent' },
  next: { en: 'Next', fr: 'Suivant' },
  random: { en: 'Shuffle', fr: 'Aléatoire' },
  songs: { en: 'Songs', fr: 'Morceaux' },
  artists: { en: 'Artists', fr: 'Artistes' },
  albums: { en: 'Albums', fr: 'Albums' },
  server: { en: 'Server', fr: 'Serveur' },
  scan: { en: 'Scan', fr: 'Scan' },
  scanUnavailable: { en: 'Unavailable', fr: 'Indisponible' },
  scanButton: { en: 'Scan', fr: 'Scanner' },
  notConfigured: {
    en: 'Fill in the server URL, username and password in the configuration.',
    fr: "Renseignez l'URL du serveur, l'utilisateur et le mot de passe dans la configuration.",
  },
};

/**
 * A text cut to a bound (the core would cut it, and say so in its logs).
 * @param {unknown} text
 * @param {number} max
 * @returns {string} the text, with an ellipsis when cut
 */
export function fit(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `Artist · Album`, whichever of the two the entry carries.
 * @param {object} entry a song entry of the API
 * @returns {string} may be empty
 */
export function describeTrack(entry) {
  return [entry?.artist, entry?.album]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' · ');
}

/**
 * A content made of one sentence, for the states where the widget cannot
 * show its data (not configured, server unreachable).
 * @param {{ en: string, fr?: string }|string} text
 * @param {number} [ttl]
 */
export function messageContent(text, ttl = TTL.MESSAGE) {
  const fitted =
    typeof text === 'string'
      ? fit(text, 300)
      : Object.fromEntries(Object.entries(text).map(([lang, value]) => [lang, fit(value, 300)]));
  return { ttl_seconds: ttl, components: [{ type: 'text', variant: 'body', text: fitted }] };
}

/** The content shown before the server is configured. */
export function notConfiguredContent() {
  return messageContent(T.notConfigured);
}

/**
 * The content shown when the server did not answer.
 * @param {string} message the error message
 */
export function unreachableContent(message) {
  return messageContent(
    {
      en: `Cannot reach the server: ${message}`,
      fr: `Serveur injoignable : ${message}`,
    },
    TTL.NOW_PLAYING,
  );
}

/**
 * Content of the now_playing widget.
 * @param {{ entries: Array<object>, streamsFeature: string,
 *   register: (coverArtId: string) => string }} input
 *   `entries` are the getNowPlaying entries, `streamsFeature` the external
 *   id of the server's active streams feature, `register` records a cover
 *   art id and returns its image key.
 */
export function buildNowPlayingContent({ entries, streamsFeature, register }) {
  const components = [
    { type: 'value', device_feature: streamsFeature, label: T.streams, icon: 'play-circle' },
  ];
  // What really plays first, then the sessions the server still lists
  // (paused, or silent since a while).
  const listed = [...entries.filter(isPlaying), ...entries.filter((e) => !isPlaying(e))].slice(
    0,
    MAX_LIST_ITEMS,
  );
  if (listed.length === 0) {
    components.push({ type: 'text', variant: 'body', text: T.nothingPlaying });
    return { ttl_seconds: TTL.NOW_PLAYING, components };
  }
  components.push({
    type: 'card-list',
    display: 'list',
    items: listed.map((entry) => {
      const item = {
        title: entry.title ? fit(entry.title, 60) : T.unknownTrack,
      };
      const subtitle = describeTrack(entry);
      if (subtitle) {
        item.subtitle = fit(subtitle, 60);
      }
      const who = entry.playerName || entry.username;
      if (who) {
        item.badge = {
          text: fit(who, 16),
          color: isPlaying(entry) ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
        };
      }
      if (entry.coverArt) {
        item.image = register(entry.coverArt);
      }
      return item;
    }),
  });
  return { ttl_seconds: TTL.NOW_PLAYING, components };
}

/**
 * The track the jukebox is on, from a `jukeboxControl get` answer.
 * @param {object} playlist `{ currentIndex, playing, gain, entry }`
 * @returns {{ entries: Array<object>, index: number, current: object|null }}
 */
export function currentJukeboxTrack(playlist) {
  const entries = asArray(playlist?.entry);
  const reported = Number(playlist?.currentIndex);
  const index =
    Number.isInteger(reported) && reported >= 0 && reported < entries.length ? reported : 0;
  return { entries, index, current: entries[index] ?? null };
}

/**
 * Content of the jukebox widget.
 * @param {{ enabled: boolean, playlist?: object,
 *   register: (coverArtId: string) => string }} input
 *   `enabled` is the `jukebox_enabled` config toggle, `playlist` the answer
 *   of `jukeboxControl get`.
 */
export function buildJukeboxContent({ enabled, playlist, register }) {
  if (!enabled) {
    return messageContent(T.jukeboxDisabled);
  }
  const button = (label, icon, key) => ({ type: 'button', label, icon, action: { key } });
  const random = button(T.random, 'shuffle', JUKEBOX_ACTION.RANDOM);
  const { entries, index, current } = currentJukeboxTrack(playlist);
  if (!current) {
    return {
      ttl_seconds: TTL.JUKEBOX,
      components: [{ type: 'text', variant: 'heading', text: T.emptyQueue }, random],
    };
  }

  const playing = playlist.playing === true;
  const components = [
    {
      type: 'text',
      variant: 'heading',
      text: current.title ? fit(current.title, 40) : T.unknownTrack,
    },
  ];
  const caption = describeTrack(current);
  if (caption) {
    components.push({ type: 'text', variant: 'caption', text: fit(caption, 80) });
  }
  if (current.coverArt) {
    components.push({
      type: 'image',
      key: register(current.coverArt),
      alt: fit(current.title || current.album || 'cover', 80),
      // A square cover in a 16:9 frame: shown whole, never cropped.
      fit: 'contain',
    });
  }
  const status = [
    {
      label: T.state,
      value: playing ? T.playing : T.stopped,
      color: playing ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
  ];
  const gain = Number(playlist.gain);
  if (Number.isFinite(gain)) {
    status.push({
      label: T.volume,
      value: `${Math.round(Math.min(Math.max(gain, 0), 1) * 100)} %`,
    });
  }
  status.push({ label: T.queue, value: `${index + 1} / ${entries.length}` });
  components.push({ type: 'status', items: status });
  components.push(
    playing
      ? button(T.pause, 'pause', JUKEBOX_ACTION.TOGGLE)
      : button(T.play, 'play', JUKEBOX_ACTION.TOGGLE),
    button(T.previous, 'skip-back', JUKEBOX_ACTION.PREVIOUS),
    button(T.next, 'skip-forward', JUKEBOX_ACTION.NEXT),
    random,
  );
  return { ttl_seconds: TTL.JUKEBOX, components };
}

/**
 * The server identity, as the ping reports it: `navidrome 0.53.3` for an
 * OpenSubsonic server, the API version otherwise.
 * @param {{ version?: string, type?: string, serverVersion?: string }|null} info
 * @returns {string}
 */
export function describeServer(info) {
  if (info?.type) {
    return fit(`${info.type} ${info.serverVersion ?? ''}`.trim(), 40);
  }
  return info?.version ? `Subsonic API ${info.version}` : 'Subsonic';
}

/**
 * Content of the library widget.
 * @param {{ features: { songs: string, artists: string, albums: string },
 *   serverInfo: object|null, scanStatus: object|null }} input
 *   `features` are the external ids of the three counters, `serverInfo` the
 *   answer of `ping`, `scanStatus` the answer of `getScanStatus` (null when
 *   the server refuses it).
 */
export function buildLibraryContent({ features, serverInfo, scanStatus }) {
  const tile = (label, feature, icon) => ({ type: 'value', device_feature: feature, label, icon });
  const scanning = scanStatus?.scanning === true;
  const count = Number(scanStatus?.count);
  const counted = Number.isFinite(count) ? ` · ${count}` : '';

  let scanRow;
  if (scanStatus === null || scanStatus === undefined) {
    scanRow = { label: T.scan, value: T.scanUnavailable, color: WIDGET_COLORS.NEUTRAL };
  } else if (scanning) {
    scanRow = {
      label: T.scan,
      value: { en: `Running${counted}`, fr: `En cours${counted}` },
      color: WIDGET_COLORS.INFO,
    };
  } else {
    scanRow = {
      label: T.scan,
      value: Number.isFinite(count)
        ? { en: `Done · ${count} songs`, fr: `Terminé · ${count} morceaux` }
        : { en: 'Done', fr: 'Terminé' },
      color: WIDGET_COLORS.NEUTRAL,
    };
  }

  return {
    ttl_seconds: scanning ? TTL.LIBRARY_SCANNING : TTL.LIBRARY,
    components: [
      tile(T.songs, features.songs, 'music'),
      tile(T.artists, features.artists, 'users'),
      tile(T.albums, features.albums, 'disc'),
      {
        type: 'status',
        items: [{ label: T.server, value: describeServer(serverInfo), icon: 'server' }, scanRow],
      },
      {
        type: 'button',
        label: T.scanButton,
        icon: 'refresh-cw',
        action: { key: LIBRARY_ACTION.SCAN },
      },
    ],
  };
}
