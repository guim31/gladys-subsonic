// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const connectionStatuses = [];

  return {
    published,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
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
    return {
      ok: true,
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
