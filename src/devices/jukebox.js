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

const DEVICE_TYPE = 'jukebox';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  VOLUME: 'volume',
  PLAYBACK_STATE: 'playback-state',
};

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
      // Gladys only accepts a closed list of values, in ms: snap to it.
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
        // `skip` needs the target index: read the queue first.
        const playlist = await jukeboxControl(config, 'get');
        const entries = asArray(playlist.entry);
        const current = playlist.currentIndex ?? 0;
        const target = feature.type === DEVICE_FEATURE_TYPES.MUSIC.NEXT ? current + 1 : current - 1;
        if (target < 0 || (entries.length > 0 && target >= entries.length)) {
          throw new Error(`No track at position ${target} in the jukebox queue`);
        }
        await jukeboxControl(config, 'skip', { index: target });
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
      const count = Math.min(Math.max(Number(fields?.count) || 20, 1), 500);
      logger.info(`Action jukebox_play_random -> queuing ${count} random songs`);

      const songs = await getRandomSongs(config, count);
      if (songs.length === 0) {
        return {
          en: 'The library returned no songs.',
          fr: "La bibliothèque n'a renvoyé aucun morceau.",
        };
      }
      await jukeboxControl(config, 'clear');
      await jukeboxControl(config, 'add', { id: songs.map((song) => song.id) });
      await jukeboxControl(config, 'start');
      return {
        en: `Playing ${songs.length} random songs on the jukebox.`,
        fr: `Lecture de ${songs.length} morceaux aléatoires sur le jukebox.`,
      };
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
