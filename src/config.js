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
// in MILLISECONDS (DEVICE_POLL_FREQUENCIES in the Gladys server): 60000,
// 30000, 15000, 10000, 2000 and 1000. Anything else rejects the whole
// device publication with "invalid poll frequency". Sub-10s HTTP polling
// of a music server is pointless, so we only ever emit these:
const ALLOWED_POLL_SECONDS = [60, 30, 15, 10];

/**
 * Convert the configured interval (seconds) into a poll_frequency Gladys
 * accepts: the closest allowed value, in milliseconds.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {number} milliseconds
 */
export function pollFrequencyMs(config) {
  const seconds = Number(config.poll_frequency);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.poll_frequency * 1000;
  }
  const closest = ALLOWED_POLL_SECONDS.reduce((best, candidate) =>
    Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best,
  );
  return closest * 1000;
}
