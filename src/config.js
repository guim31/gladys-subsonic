// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  server_url: '', // e.g. https://music.example.com (Navidrome, Airsonic...)
  username: '',
  password: '',
  auth_method: 'token', // 'token' (md5 + salt) | 'legacy' (hex-encoded password)
  poll_frequency: 60, // seconds, how often the server is polled
  jukebox_enabled: false, // create the jukebox device (server-side playback)
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // The URL is used as a prefix everywhere: no surrounding spaces, no
    // trailing slash (we always append `/rest/...` ourselves), and always a
    // scheme — users commonly type a bare `192.168.1.10:4533`, which fetch()
    // cannot parse, so default to http:// when none is given.
    server_url: normalizeServerUrl(raw.server_url ?? DEFAULT_CONFIG.server_url),
    username: String(raw.username ?? DEFAULT_CONFIG.username).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    auth_method: raw.auth_method === 'legacy' ? 'legacy' : 'token',
    // Force the types: config may arrive as strings from a form.
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    jukebox_enabled: raw.jukebox_enabled === true || raw.jukebox_enabled === 'true',
  };
}

/**
 * Trim, strip the trailing slash, and add the missing scheme (http:// by
 * default: LAN installs rarely have TLS; anyone with TLS types https://).
 * @param {unknown} rawUrl
 * @returns {string}
 */
function normalizeServerUrl(rawUrl) {
  const url = String(rawUrl).trim().replace(/\/+$/, '');
  if (url === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url;
  }
  return `http://${url}`;
}

/**
 * The integration can only talk to the server once these three fields are set.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return Boolean(config.server_url && config.username && config.password);
}

// Gladys only accepts a device `poll_frequency` from a closed list of values,
// in MILLISECONDS (DEVICE_POLL_FREQUENCIES, mirrored by the SDK). Anything
// else rejects the whole device publication with "invalid poll frequency".
// Sub-10s HTTP polling of a music server is pointless, so we only ever emit
// these (the container's own timer, src/poller.js, uses the same pace):
const ALLOWED_POLL_MS = [
  DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
  DEVICE_POLL_FREQUENCIES.EVERY_30_SECONDS,
  DEVICE_POLL_FREQUENCIES.EVERY_15_SECONDS,
  DEVICE_POLL_FREQUENCIES.EVERY_10_SECONDS,
];

/**
 * Convert the configured interval (seconds) into a poll_frequency Gladys
 * accepts: the closest allowed value, in milliseconds.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {number} milliseconds
 */
export function pollFrequencyMs(config) {
  const ms = Number(config.poll_frequency) * 1000;
  if (!Number.isFinite(ms)) {
    return DEFAULT_CONFIG.poll_frequency * 1000;
  }
  return ALLOWED_POLL_MS.reduce((best, candidate) =>
    Math.abs(candidate - ms) < Math.abs(best - ms) ? candidate : best,
  );
}
