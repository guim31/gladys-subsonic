// -----------------------------------------------------------------------------
// Subsonic API client.
//
// Talks to any server implementing the Subsonic REST API (Navidrome,
// Airsonic-Advanced, Gonic, LMS, the original Subsonic...):
// https://www.subsonic.org/pages/api.jsp
//
// Every call is a GET on `<server>/rest/<endpoint>.view` with the auth
// parameters appended. Responses are requested in JSON (`f=json`) and wrapped
// in a `subsonic-response` envelope carrying `status: "ok" | "failed"`.
//
// Node 20+ provides `fetch` natively: no dependency needed.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'subsonic' });

// Highest version of the original Subsonic API: understood by every modern
// implementation, and the one that introduced token authentication is 1.13.0.
export const API_VERSION = '1.16.1';
export const CLIENT_NAME = 'gladys-subsonic';

// Error codes defined by the API specification.
const ERROR_MESSAGES = {
  0: 'generic server error',
  10: 'missing required parameter',
  20: 'incompatible client protocol version',
  30: 'incompatible server protocol version',
  40: 'wrong username or password',
  41: 'token authentication not supported (LDAP user?), try the legacy method',
  50: 'user not authorized for this operation',
  60: 'server trial period expired',
  70: 'requested data not found',
};

export class SubsonicError extends Error {
  constructor(code, message) {
    super(`Subsonic error ${code}: ${message || ERROR_MESSAGES[code] || 'unknown error'}`);
    this.code = code;
  }
}

/**
 * Build the authentication query parameters.
 *
 * Default ("token") scheme: t = md5(password + salt) with a random salt per
 * request, so the password itself never transits. Some setups (LDAP users,
 * pre-1.13 servers) only accept the legacy scheme: the hex-obfuscated
 * password (`p=enc:...`).
 *
 * @param {{ username: string, password: string, auth_method: string }} config
 * @param {string} [salt] fixed salt, for tests only (random otherwise)
 * @returns {Record<string, string>}
 */
export function buildAuthParams({ username, password, auth_method }, salt) {
  const base = { u: username, v: API_VERSION, c: CLIENT_NAME, f: 'json' };
  if (auth_method === 'legacy') {
    return { ...base, p: `enc:${Buffer.from(password, 'utf8').toString('hex')}` };
  }
  const s = salt ?? randomBytes(8).toString('hex');
  const t = createHash('md5').update(`${password}${s}`).digest('hex');
  return { ...base, t, s };
}

/**
 * Build the full request URL for an endpoint.
 * @param {object} config normalized config (server_url has no trailing slash)
 * @param {string} endpoint e.g. 'ping', 'getNowPlaying'
 * @param {Record<string, unknown>} params extra query parameters; an array
 *   value is appended once per element (e.g. jukeboxControl `id` list)
 * @param {string} [salt] fixed salt, for tests only
 * @returns {string}
 */
export function buildUrl(config, endpoint, params = {}, salt) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...buildAuthParams(config, salt), ...params })) {
    if (value === undefined || value === null) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      search.append(key, String(item));
    }
  }
  // `.view` suffix: required by older Subsonic servers, accepted by all.
  return `${config.server_url}/rest/${endpoint}.view?${search.toString()}`;
}

/**
 * Call an endpoint and return the `subsonic-response` envelope content.
 * Throws on HTTP errors and on `status: "failed"` envelopes.
 * @param {object} config normalized config
 * @param {string} endpoint
 * @param {Record<string, unknown>} params
 * @returns {Promise<object>} the envelope (e.g. `{ status, version, scanStatus }`)
 */
export async function request(config, endpoint, params = {}) {
  const url = buildUrl(config, endpoint, params);
  logger.debug(`-> ${endpoint}`);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    // fetch errors can embed the full URL, whose query carries replayable
    // credentials (t + s, or the legacy p): never let them leak into the
    // connection status or the logs. Deliberately NOT attached as `cause`,
    // for the same reason.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`${endpoint} request failed: ${redactAuth(causeMessage(err))}`);
  }
  if (!response.ok) {
    throw new Error(`Subsonic HTTP ${response.status} on ${endpoint}`);
  }

  const body = await response.json();
  const envelope = body['subsonic-response'];
  if (!envelope) {
    throw new Error(`Not a Subsonic server: missing response envelope on ${endpoint}`);
  }
  if (envelope.status !== 'ok') {
    throw new SubsonicError(envelope.error?.code ?? 0, envelope.error?.message);
  }
  return envelope;
}

/**
 * Blank out the sensitive auth query parameters (token, salt, password) in a
 * text that may embed a request URL.
 * @param {string} text
 * @returns {string}
 */
export function redactAuth(text) {
  return text.replace(/([?&](?:t|s|p)=)[^&\s"']+/gi, '$1***');
}

/** Prefer the network cause of a fetch TypeError over its generic message. */
function causeMessage(err) {
  const cause = err?.cause?.message ?? err?.cause?.code;
  return cause ? `${err.message} (${cause})` : (err?.message ?? String(err));
}

/**
 * The API returns a single child as an object and several as an array:
 * normalize to an array so callers never care.
 * @param {unknown} value
 * @returns {Array<object>}
 */
export function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// --- Thin endpoint wrappers --------------------------------------------------

/** Test connectivity and credentials. Returns `{ version, type?, serverVersion? }`. */
export async function ping(config) {
  const envelope = await request(config, 'ping');
  return {
    version: envelope.version,
    // OpenSubsonic servers (Navidrome...) also identify themselves.
    type: envelope.type,
    serverVersion: envelope.serverVersion,
  };
}

/** Entries currently being played, one per active stream/player. */
export async function getNowPlaying(config) {
  const envelope = await request(config, 'getNowPlaying');
  return asArray(envelope.nowPlaying?.entry);
}

/** All artists (ID3 tags), flattened from the alphabetical index. */
export async function getArtists(config) {
  const envelope = await request(config, 'getArtists');
  return asArray(envelope.artists?.index).flatMap((index) => asArray(index.artist));
}

/** Media library scan status: `{ scanning, count }`. */
export async function getScanStatus(config) {
  const envelope = await request(config, 'getScanStatus');
  return envelope.scanStatus ?? {};
}

/** Start a media library scan. Returns the same shape as getScanStatus. */
export async function startScan(config) {
  const envelope = await request(config, 'startScan');
  return envelope.scanStatus ?? {};
}

/** All playlists visible to the user. */
export async function getPlaylists(config) {
  const envelope = await request(config, 'getPlaylists');
  return asArray(envelope.playlists?.playlist);
}

/** One playlist with its songs: `{ ...playlist, entry: [...] }`. */
export async function getPlaylist(config, id) {
  const envelope = await request(config, 'getPlaylist', { id });
  const playlist = envelope.playlist ?? {};
  return { ...playlist, entry: asArray(playlist.entry) };
}

/** Random songs from the library. */
export async function getRandomSongs(config, size = 20) {
  const envelope = await request(config, 'getRandomSongs', { size });
  return asArray(envelope.randomSongs?.song);
}

/**
 * Control the server-side jukebox (playback on the machine hosting the
 * server; must be enabled server-side, e.g. `Jukebox.Enabled` in Navidrome).
 * @param {object} config
 * @param {string} action get|status|set|start|stop|skip|add|clear|remove|shuffle|setGain
 * @param {Record<string, unknown>} params e.g. `{ id: [...] }`, `{ index }`, `{ gain }`
 * @returns {Promise<object>} `jukeboxStatus` (or `jukeboxPlaylist` for `get`)
 */
export async function jukeboxControl(config, action, params = {}) {
  const envelope = await request(config, 'jukeboxControl', { action, ...params });
  return envelope.jukeboxPlaylist ?? envelope.jukeboxStatus ?? {};
}
