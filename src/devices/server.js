// -----------------------------------------------------------------------------
// Device type: SUBSONIC SERVER
// Read-only sensors about the music server, refreshed by polling:
//   - active streams (how many songs are being played right now);
//   - now playing (free text: artist — title, and who is listening);
//   - songs, artists and albums counted in the library.
// Also owns the `test_connection` and `start_scan` configuration actions.
//
// Polling budget: getNowPlaying and getScanStatus are small answers, polled
// every time. getArtists is NOT: it returns the whole artist list, which is
// heavy on a large library, and its counts only move when the library is
// re-scanned. It is therefore fetched only when the scan signature reported
// by getScanStatus changes (or once an hour as a safety net) and served from
// a cache in between — the published values stay fresh every poll either way.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import {
  ping,
  getNowPlaying,
  getArtists,
  startScan,
  getScanStatus,
  getCoverArt,
} from '../subsonic.js';
import { isConfigured, pollFrequencyMs } from '../config.js';

const DEVICE_TYPE = 'server';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  ACTIVE_STREAMS: 'active-streams',
  NOW_PLAYING: 'now-playing',
  COVER_ART: 'cover-art',
  SONG_COUNT: 'song-count',
  ARTIST_COUNT: 'artist-count',
  ALBUM_COUNT: 'album-count',
};

// Gladys refuses an image whose `<mime>;base64,...` string exceeds 150 KB.
const MAX_IMAGE_SIZE = 150 * 1024;

// Sizes asked to the server, largest first: the first one that fits wins.
// A 500 px JPEG cover is usually well under the limit; the smaller steps are
// there for servers that re-encode poorly or ignore the size parameter.
const COVER_ART_SIZES = [500, 300, 160];

// Gladys serves a camera image for one hour and then reports it as too old
// (CAMERA_IMAGE_EXPIRATION_TIME_IN_HOURS), so a widget opened after a quiet
// evening would find nothing to show. Re-send the current image well within
// that window: the bytes are cached, this costs no request to the server.
const COVER_REPUBLISH_MS = 10 * 60 * 1000;

// Shown while nothing is playing on a server we have never seen play
// anything — without it the widget has no image at all to render. Kept as
// readable SVG (a few hundred bytes, crisp at any size) rather than an
// opaque bitmap blob, and toned to sit quietly in the light Gladys theme
// instead of punching a dark square into the dashboard.
const IDLE_COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" width="480" height="480">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eaf1fb"/>
      <stop offset="0.55" stop-color="#f2f0fa"/>
      <stop offset="1" stop-color="#fbeee9"/>
    </linearGradient>
  </defs>
  <rect width="480" height="480" fill="url(#g)"/>
  <g fill="none" stroke="#b9cbe8" stroke-width="8" opacity="0.5">
    <circle cx="240" cy="240" r="150"/>
    <circle cx="240" cy="240" r="196"/>
  </g>
  <path fill="#93aed6" d="M292 130 L292 292 a44 34 0 1 1 -26 -31 L266 186 L196 206 L196 322 a44 34 0 1 1 -26 -31 L170 176 a14 14 0 0 1 11 -14 L281 116 a9 9 0 0 1 11 9 Z"/>
</svg>`;

const IDLE_COVER_IMAGE = `image/svg+xml;base64,${Buffer.from(IDLE_COVER_SVG).toString('base64')}`;

// Pseudo cover id of the placeholder, so it flows through the same
// "publish only what changed" path as a real cover.
const IDLE_COVER_ID = '__idle__';

// Re-read the artist list at most once an hour even when the library looks
// unchanged: cheap insurance against a server that does not move its scan
// signature (or does not answer getScanStatus at all).
const LIBRARY_REFRESH_MS = 60 * 60 * 1000;

// Last known library counts, and what the library looked like when they were
// read. Module-level: the integration talks to one server at a time, and the
// cached entry carries its platform id so switching server invalidates it.
let libraryCache = null;

// Cover art last sent to Gladys: publishing it again on every poll would
// burn the image rate limit (12/minute per device) for nothing, so the id is
// kept to detect a real track change. The image itself is kept so the
// on-demand path can answer even when nothing is playing any more.
let coverArtCache = null;

/** Drop the cached library counts and cover art (used by the tests). */
export function resetLibraryCache() {
  libraryCache = null;
  coverArtCache = null;
}

/**
 * Download a cover art small enough for the Gladys image channel.
 * @param {object} config
 * @param {string} coverArtId
 * @returns {Promise<string|null>} `image/jpeg;base64,...`, or null if even
 *   the smallest size the server returns is too big
 */
async function fetchCoverArt(config, coverArtId) {
  let smallest = null;
  for (const size of COVER_ART_SIZES) {
    const image = await getCoverArt(config, coverArtId, size);
    smallest = image;
    if (image.length <= MAX_IMAGE_SIZE) {
      return image;
    }
    logger.debug(`Cover art at ${size}px is ${image.length} bytes, trying smaller`);
  }
  logger.warn(`Cover art ${coverArtId} stays above ${MAX_IMAGE_SIZE} bytes, skipped`);
  return smallest !== null && smallest.length <= MAX_IMAGE_SIZE ? smallest : null;
}

/**
 * Publish the cover art of the track being played, when it changed.
 * Failures are logged and swallowed: a missing cover must never break the
 * poll that carries the sensors.
 * @param {object} gladys
 * @param {object} config
 * @param {object|undefined} entry the now playing entry to illustrate
 */
async function publishCoverArt(gladys, config, entry) {
  const platformId = serverPlatformId(config);
  const cache = coverArtCache?.platformId === platformId ? coverArtCache : null;
  // What should be on screen right now: the cover of the track being played;
  // when nothing plays, whatever was there before — and the placeholder on a
  // server we have never seen play anything, so the widget is never empty.
  let wantedId = entry?.coverArt ?? cache?.coverArtId ?? IDLE_COVER_ID;
  const alreadyOnScreen = cache !== null && cache.coverArtId === wantedId;

  if (alreadyOnScreen && Date.now() - cache.publishedAt < COVER_REPUBLISH_MS) {
    return;
  }

  let image = alreadyOnScreen ? cache.image : null;
  if (image === null && wantedId !== IDLE_COVER_ID) {
    try {
      image = await fetchCoverArt(config, wantedId);
    } catch (err) {
      logger.warn(`Cover art unavailable (${err.message})`);
      image = null;
    }
  }
  if (image === null) {
    // No usable cover for this track (none published, refused, or too big).
    // Keep whatever is already on screen; only an empty widget gets the
    // placeholder — it must never be left with nothing to render.
    if (cache !== null) {
      return;
    }
    wantedId = IDLE_COVER_ID;
    image = IDLE_COVER_IMAGE;
  }

  try {
    const deviceExternalId = gladys.externalIds(DEVICE_TYPE, platformId).device;
    await gladys.publishCameraImage(deviceExternalId, image);
    coverArtCache = { platformId, coverArtId: wantedId, image, publishedAt: Date.now() };
    if (!alreadyOnScreen) {
      logger.info(
        wantedId === IDLE_COVER_ID
          ? 'Nothing playing: published the placeholder cover'
          : `Cover art published for ${entry?.album ?? wantedId}`,
      );
    }
  } catch (err) {
    logger.warn(`Cover art could not be published (${err.message})`);
  }
}

/**
 * External ids must be unique and stable: derive the platform id from the
 * host of the configured server. Two different servers give two different
 * devices; reconfiguring the same server keeps the same device.
 * @param {{ server_url: string }} config
 * @returns {string}
 */
export function serverPlatformId(config) {
  try {
    const { host } = new URL(config.server_url);
    return host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  } catch {
    return 'unconfigured';
  }
}

/**
 * One-line summary of what the server is streaming right now, published as
 * the free text of the `now playing` feature.
 * @param {Array<object>} entries getNowPlaying entries
 * @returns {string}
 */
export function formatNowPlaying(entries) {
  if (entries.length === 0) {
    return 'Nothing playing';
  }
  const [first, ...others] = entries;
  const track = [first.artist, first.title].filter(Boolean).join(' — ') || 'Unknown track';
  const listener = first.username ? ` (${first.username})` : '';
  const more = others.length > 0 ? ` +${others.length} more` : '';
  return `${track}${listener}${more}`;
}

/**
 * Scan status, or null when the server refuses the endpoint (some servers
 * reserve it to admins): a missing scan status degrades the library refresh
 * to its hourly safety net instead of failing the whole poll.
 * @param {object} config
 * @returns {Promise<object|null>}
 */
async function readScanStatus(config) {
  try {
    return await getScanStatus(config);
  } catch (err) {
    logger.warn(`getScanStatus unavailable (${err.message}), falling back to timed refresh`);
    return null;
  }
}

/**
 * Library counts, from the cache when the library has not changed.
 * @param {object} config
 * @param {object|null} scanStatus answer of getScanStatus for this poll
 * @returns {Promise<{ artistCount: number, albumCount: number }>}
 */
async function readLibraryCounts(config, scanStatus) {
  const platformId = serverPlatformId(config);
  // `count` moves with every added file, `lastScan` with every scan: either
  // changing means the artist/album counts may have moved too.
  const signature = `${scanStatus?.count ?? ''}|${scanStatus?.lastScan ?? ''}`;
  const usable =
    libraryCache !== null &&
    libraryCache.platformId === platformId &&
    libraryCache.signature === signature &&
    Date.now() - libraryCache.fetchedAt < LIBRARY_REFRESH_MS;

  if (usable) {
    return libraryCache;
  }

  const artists = await getArtists(config);
  libraryCache = {
    platformId,
    signature,
    fetchedAt: Date.now(),
    artistCount: artists.length,
    albumCount: artists.reduce((total, artist) => total + (artist.albumCount ?? 0), 0),
  };
  logger.info(
    `Library read: ${libraryCache.artistCount} artist(s), ${libraryCache.albumCount} album(s)`,
  );
  return libraryCache;
}

export const server = {
  key: DEVICE_TYPE,

  deviceExternalId(gladys, config) {
    return gladys.externalIds(DEVICE_TYPE, serverPlatformId(config)).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
    const counter = (name, key, max) => ({
      name,
      external_id: ids.feature(key),
      category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
    return {
      name: 'Subsonic server',
      external_id: ids.device,
      // Polling is opt-in: Gladys only registers a device in its poll
      // manager when should_poll is true (it defaults to false in DB), and
      // poll_frequency must be one of its allowed values, in milliseconds.
      // Without BOTH, onPoll is never called and the sensors stay empty.
      should_poll: true,
      poll_frequency: pollFrequencyMs(config),
      features: [
        counter('Active streams', FEATURE.ACTIVE_STREAMS, 1000),
        {
          name: 'Now playing',
          external_id: ids.feature(FEATURE.NOW_PLAYING),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          // Meaningless for a text feature, but Gladys stores min/max as NOT
          // NULL columns and rejects the whole device without them: 0/0 is
          // the convention the core itself uses for text features.
          min: 0,
          max: 0,
          read_only: true,
          has_feedback: false,
          // Text states are kept as the feature's last value only (Gladys
          // stores no history for them), but they DO fire the trigger check:
          // a scene can react to the played track changing.
          keep_history: false,
        },
        {
          name: 'Album cover',
          external_id: ids.feature(FEATURE.COVER_ART),
          category: DEVICE_FEATURE_CATEGORIES.CAMERA,
          type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
          min: 0,
          max: 0,
          read_only: true,
          has_feedback: false,
          // Images travel on their own channel, never through the history.
          keep_history: false,
        },
        counter('Songs in library', FEATURE.SONG_COUNT, 10000000),
        counter('Artists in library', FEATURE.ARTIST_COUNT, 1000000),
        counter('Albums in library', FEATURE.ALBUM_COUNT, 10000000),
      ],
    };
  },

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
    logger.debug('Polling the Subsonic server...');

    const [nowPlaying, scanStatus] = await Promise.all([
      getNowPlaying(config),
      readScanStatus(config),
    ]);
    const library = await readLibraryCounts(config, scanStatus);
    const nowPlayingText = formatNowPlaying(nowPlaying);

    logger.info(`Server polled: ${nowPlaying.length} active stream(s) — ${nowPlayingText}`);

    const states = [
      { device_feature_external_id: ids.feature(FEATURE.ACTIVE_STREAMS), state: nowPlaying.length },
      { device_feature_external_id: ids.feature(FEATURE.NOW_PLAYING), text: nowPlayingText },
      { device_feature_external_id: ids.feature(FEATURE.ARTIST_COUNT), state: library.artistCount },
      { device_feature_external_id: ids.feature(FEATURE.ALBUM_COUNT), state: library.albumCount },
    ];
    // Only servers reporting a song count get that sensor: publishing a 0 we
    // did not measure would be a lie on the dashboard and in the history.
    const songCount = Number(scanStatus?.count);
    if (Number.isFinite(songCount)) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.SONG_COUNT),
        state: songCount,
      });
    }

    await gladys.publishStates(states);

    // After the states: the cover art travels on its own channel, and a
    // failure there must not cost us the sensors.
    await publishCoverArt(gladys, config, nowPlaying[0]);
  },

  // Gladys asks for a FRESH image (dashboard live view, chat intent). Read
  // what is playing right now rather than serving the cache blindly; the
  // cache is the fallback when nothing is playing any more.
  async onGetImage(gladys, { config }) {
    const platformId = serverPlatformId(config);
    const [entry] = await getNowPlaying(config);
    if (entry?.coverArt) {
      const image = await fetchCoverArt(config, entry.coverArt);
      if (image !== null) {
        coverArtCache = {
          platformId,
          coverArtId: entry.coverArt,
          image,
          publishedAt: Date.now(),
        };
        return image;
      }
    }
    // Nothing playing: the last cover we showed, or the placeholder. Never
    // throw — an unanswered request leaves a broken image in the widget.
    return coverArtCache?.platformId === platformId ? coverArtCache.image : IDLE_COVER_IMAGE;
  },

  // Manifest actions owned by this device type (see the `actions` field of
  // `gladys-assistant-integration.json`): buttons in the Configuration screen.
  actions: {
    async test_connection(_gladys, { config }) {
      if (!isConfigured(config)) {
        return {
          en: 'Fill in the server URL, username and password first.',
          fr: "Renseignez d'abord l'URL du serveur, l'utilisateur et le mot de passe.",
        };
      }
      logger.info('Action test_connection -> pinging the server');
      const info = await ping(config);
      // OpenSubsonic servers (Navidrome...) identify themselves in the ping.
      const serverName = info.type
        ? `${info.type} ${info.serverVersion ?? ''}`.trim()
        : 'Subsonic-compatible server';
      return {
        en: `Connected to ${serverName} (Subsonic API ${info.version}).`,
        fr: `Connecté à ${serverName} (API Subsonic ${info.version}).`,
      };
    },

    async start_scan(_gladys, { config }) {
      if (!isConfigured(config)) {
        return {
          en: 'Fill in the server URL, username and password first.',
          fr: "Renseignez d'abord l'URL du serveur, l'utilisateur et le mot de passe.",
        };
      }
      logger.info('Action start_scan -> starting a library scan');
      let status;
      try {
        status = await startScan(config);
      } catch (err) {
        // Some servers refuse startScan for non-admin users: still report the
        // current scan status instead of a bare failure.
        logger.warn(`startScan refused (${err.message}), falling back to getScanStatus`);
        status = await getScanStatus(config);
        return {
          en: `Scan could not be started (${err.message}). Currently scanning: ${status.scanning ? 'yes' : 'no'}.`,
          fr: `Impossible de lancer le scan (${err.message}). Scan en cours : ${status.scanning ? 'oui' : 'non'}.`,
        };
      }
      const count = status.count !== undefined ? ` (${status.count} items so far)` : '';
      const countFr =
        status.count !== undefined ? ` (${status.count} éléments pour l'instant)` : '';
      return {
        en: status.scanning ? `Library scan in progress${count}.` : 'Library scan finished.',
        fr: status.scanning
          ? `Scan de la bibliothèque en cours${countFr}.`
          : 'Scan de la bibliothèque terminé.',
      };
    },
  },
};
