// -----------------------------------------------------------------------------
// The SDK's fake Gladys (`@gladysassistant/integration-sdk/testing`), with the
// short views the device tests assert on.
//
// It is a REAL GladysIntegration whose transport is an in-memory Gladys: the
// payloads are checked like the host API does (external id prefix, numeric
// `state` or string `text`, known category/type, poll frequency), and
// publishChangedStates deduplicates for real. Feature ids carry the SDK
// prefix: `ext:test-integration:server:<platform>:<key>`.
//   - published          -> every accepted state, `{ featureExternalId, state|text }`
//   - cameraImages       -> every accepted image, `{ deviceExternalId, image }`
//   - connectionStatuses -> every published status, `{ connected, message? }`
// -----------------------------------------------------------------------------

import { createFakeGladys as createSdkFakeGladys } from '@gladysassistant/integration-sdk/testing';

/** Prefix the SDK fake puts in front of every external id. */
export const ID_PREFIX = 'ext:test-integration:';

/**
 * @param {object} [options] passed to the SDK's createFakeGladys (devices, config...)
 */
export function createFakeGladys(options = {}) {
  const gladys = createSdkFakeGladys(options);
  Object.defineProperties(gladys, {
    published: {
      get: () =>
        gladys.fake.states.map((s) => {
          const entry = { featureExternalId: s.device_feature_external_id };
          if (s.state !== undefined) {
            entry.state = s.state;
          }
          if (s.text !== undefined) {
            entry.text = s.text;
          }
          return entry;
        }),
    },
    cameraImages: {
      get: () =>
        gladys.fake.cameraImages.map((c) => ({
          deviceExternalId: c.device_external_id,
          image: c.image,
        })),
    },
    connectionStatuses: {
      get: () => gladys.fake.connectionStatuses,
    },
  });
  return gladys;
}

/**
 * Replace the global fetch with a stub answering Subsonic envelopes.
 * `routes` maps an endpoint name (e.g. 'ping') to either an envelope body
 * (merged into `{ status: 'ok', version: '1.16.1' }`) or a function
 * `(url) => body` for asserting the query. Returns the recorded calls and a
 * restore function.
 */
export function mockSubsonicFetch(routes) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = String(url).match(/\/rest\/([^.]+)\.view/)?.[1];
    calls.push({ endpoint, url: new URL(String(url)) });
    const route = routes[endpoint];
    if (route === undefined) {
      throw new Error(`Unexpected Subsonic call: ${endpoint}`);
    }
    const body = typeof route === 'function' ? route(new URL(String(url))) : route;
    // A route can answer with raw image bytes instead of the JSON envelope
    // (getCoverArt): `{ __image: <Buffer|string>, __mime: 'image/jpeg' }`.
    if (body && body.__image !== undefined) {
      const bytes = Buffer.from(body.__image);
      return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? body.__mime : null) },
        arrayBuffer: async () => bytes,
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        'subsonic-response': { status: 'ok', version: '1.16.1', ...body },
      }),
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
