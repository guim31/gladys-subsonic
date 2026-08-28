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
    // trailing slash (we always append `/rest/...` ourselves).
    server_url: String(raw.server_url ?? DEFAULT_CONFIG.server_url)
      .trim()
      .replace(/\/+$/, ''),
    username: String(raw.username ?? DEFAULT_CONFIG.username).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    auth_method: raw.auth_method === 'legacy' ? 'legacy' : 'token',
    // Force the types: config may arrive as strings from a form.
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    jukebox_enabled: raw.jukebox_enabled === true || raw.jukebox_enabled === 'true',
  };
}

/**
 * The integration can only talk to the server once these three fields are set.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return Boolean(config.server_url && config.username && config.password);
}
