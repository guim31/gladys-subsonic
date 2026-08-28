// -----------------------------------------------------------------------------
// Device type: SUBSONIC SERVER
// Read-only sensors about the music server, refreshed by polling:
//   - active streams (how many songs are being played right now);
//   - artists and albums counted in the library.
// Also owns the `test_connection` and `start_scan` configuration actions.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { ping, getNowPlaying, getArtists, startScan, getScanStatus } from '../subsonic.js';
import { isConfigured, pollFrequencyMs } from '../config.js';

const DEVICE_TYPE = 'server';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  ACTIVE_STREAMS: 'active-streams',
  ARTIST_COUNT: 'artist-count',
  ALBUM_COUNT: 'album-count',
};

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

export const server = {
  key: DEVICE_TYPE,

  deviceExternalId(gladys, config) {
    return gladys.externalIds(DEVICE_TYPE, serverPlatformId(config)).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
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
        {
          name: 'Active streams',
          external_id: ids.feature(FEATURE.ACTIVE_STREAMS),
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          min: 0,
          max: 1000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Artists in library',
          external_id: ids.feature(FEATURE.ARTIST_COUNT),
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          min: 0,
          max: 1000000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Albums in library',
          external_id: ids.feature(FEATURE.ALBUM_COUNT),
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          min: 0,
          max: 10000000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, serverPlatformId(config));
    logger.debug('Polling the Subsonic server...');

    const [nowPlaying, artists] = await Promise.all([getNowPlaying(config), getArtists(config)]);
    const albumCount = artists.reduce((total, artist) => total + (artist.albumCount ?? 0), 0);

    logger.info(
      `Server polled: ${nowPlaying.length} active stream(s), ` +
        `${artists.length} artist(s), ${albumCount} album(s)`,
    );

    await gladys.publishStates([
      { device_feature_external_id: ids.feature(FEATURE.ACTIVE_STREAMS), state: nowPlaying.length },
      { device_feature_external_id: ids.feature(FEATURE.ARTIST_COUNT), state: artists.length },
      { device_feature_external_id: ids.feature(FEATURE.ALBUM_COUNT), state: albumCount },
    ]);
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
