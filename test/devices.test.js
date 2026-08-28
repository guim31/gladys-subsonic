import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  activeBlueprints,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import { server, serverPlatformId } from '../src/devices/server.js';
import { jukebox } from '../src/devices/jukebox.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, mockSubsonicFetch } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const baseConfig = normalizeConfig({
  server_url: 'https://music.example.com',
  username: 'admin',
  password: 'sesame',
});
const jukeboxConfig = normalizeConfig({ ...baseConfig, jukebox_enabled: true });

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.equal(typeof bp.deviceExternalId, 'function', 'deviceExternalId must be a function');
    assert.equal(typeof bp.buildDevice, 'function', 'buildDevice must be a function');
  }
});

test('nothing is discovered before the server is configured', () => {
  assert.deepEqual(buildDiscoveredDevices(gladys, normalizeConfig()), []);
});

test('the jukebox device only exists when its toggle is on', () => {
  assert.deepEqual(
    activeBlueprints(baseConfig).map((bp) => bp.key),
    ['server'],
  );
  assert.deepEqual(
    activeBlueprints(jukeboxConfig).map((bp) => bp.key),
    ['server', 'jukebox'],
  );
});

test('the platform id derives from the server host, stable and url-safe', () => {
  assert.equal(serverPlatformId(baseConfig), 'music-example-com');
  assert.equal(
    serverPlatformId(normalizeConfig({ server_url: 'http://192.168.1.10:4533' })),
    '192-168-1-10-4533',
  );
  assert.equal(serverPlatformId(normalizeConfig()), 'unconfigured');
});

test('device external_ids are unique across the catalog', () => {
  const devices = buildDiscoveredDevices(gladys, jukeboxConfig);
  const ids = devices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
});

test('findBlueprintByDevice routes an external_id back to its owner blueprint', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    const external_id = bp.deviceExternalId(gladys, jukeboxConfig);
    assert.equal(findBlueprintByDevice(gladys, { external_id }, jukeboxConfig), bp);
  }
  assert.equal(
    findBlueprintByDevice(gladys, { external_id: 'does-not-exist' }, jukeboxConfig),
    undefined,
  );
});

test('manifest action keys are unique across blueprints', () => {
  const keys = DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {}));
  assert.equal(new Set(keys).size, keys.length, 'no two blueprints may register the same action');
});

test('every polled device opts into polling explicitly', () => {
  // Gladys registers a device in its poll manager only when should_poll is
  // true (should_poll defaults to false in DB): a device carrying onPoll but
  // not the flag is silently never polled, and its sensors stay empty.
  for (const bp of DEVICE_BLUEPRINTS) {
    if (typeof bp.onPoll !== 'function') {
      continue;
    }
    const device = bp.buildDevice(gladys, jukeboxConfig);
    assert.equal(device.should_poll, true, `${bp.key} must declare should_poll`);
    assert.ok(device.poll_frequency > 0, `${bp.key} must declare a poll_frequency`);
  }
});

test('the server device carries the three read-only counter sensors', () => {
  const device = server.buildDevice(gladys, baseConfig);
  // 60 s in config -> 60000 ms, one of the values Gladys accepts.
  assert.equal(device.poll_frequency, 60000);
  assert.equal(device.features.length, 3);
  for (const feature of device.features) {
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
    assert.equal(feature.read_only, true);
  }
});

test('server onPoll publishes streams, artists and albums from the API', async () => {
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    getNowPlaying: { nowPlaying: { entry: [{ id: 'a' }, { id: 'b' }] } },
    getArtists: {
      artists: {
        index: [
          { name: 'A', artist: [{ id: '1', albumCount: 3 }] },
          // Single child returned as an object, not an array (XML heritage).
          { name: 'B', artist: { id: '2', albumCount: 2 } },
        ],
      },
    },
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const byFeature = Object.fromEntries(fake.published.map((p) => [p.featureExternalId, p.state]));
  assert.equal(byFeature['server:music-example-com:active-streams'], 2);
  assert.equal(byFeature['server:music-example-com:artist-count'], 2);
  assert.equal(byFeature['server:music-example-com:album-count'], 5);
});

test('the jukebox music features cover commands, volume and playback state', () => {
  const device = jukebox.buildDevice(gladys, jukeboxConfig);
  const types = device.features.map((f) => f.type).sort();
  assert.deepEqual(types, ['next', 'pause', 'play', 'playback_state', 'previous', 'volume'].sort());
  for (const feature of device.features) {
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.MUSIC);
  }
  const playback = device.features.find((f) => f.type === 'playback_state');
  assert.equal(playback.read_only, true);
  const volume = device.features.find((f) => f.type === 'volume');
  assert.equal(volume.max, 100);
  assert.equal(volume.has_feedback, true);
});

test('jukebox volume maps 0-100 to the 0.0-1.0 gain and publishes the feedback', async () => {
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    jukeboxControl: (url) => {
      assert.equal(url.searchParams.get('action'), 'setGain');
      assert.equal(url.searchParams.get('gain'), '0.4');
      return { jukeboxStatus: { playing: true, gain: 0.4 } };
    },
  });
  try {
    const volumeFeature = jukebox
      .buildDevice(fake, jukeboxConfig)
      .features.find((f) => f.type === 'volume');
    await jukebox.onSetValue(fake, {
      device: {},
      feature: volumeFeature,
      value: 40,
      config: jukeboxConfig,
    });
  } finally {
    mock.restore();
  }
  assert.deepEqual(fake.published, [
    { featureExternalId: 'jukebox:music-example-com:volume', state: 40 },
  ]);
});

test('jukebox next skips to the following index of the queue', async () => {
  const fake = createFakeGladys();
  const actions = [];
  const mock = mockSubsonicFetch({
    jukeboxControl: (url) => {
      actions.push(Object.fromEntries(url.searchParams));
      if (url.searchParams.get('action') === 'get') {
        return {
          jukeboxPlaylist: { currentIndex: 1, playing: true, entry: [{}, {}, {}] },
        };
      }
      return { jukeboxStatus: { currentIndex: 2, playing: true } };
    },
  });
  try {
    const nextFeature = jukebox
      .buildDevice(fake, jukeboxConfig)
      .features.find((f) => f.type === 'next');
    await jukebox.onSetValue(fake, {
      device: {},
      feature: nextFeature,
      value: 1,
      config: jukeboxConfig,
    });
  } finally {
    mock.restore();
  }
  assert.equal(actions[0].action, 'get');
  assert.equal(actions[1].action, 'skip');
  assert.equal(actions[1].index, '2');
});

test('jukebox onPoll publishes the playback state and the volume', async () => {
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    jukeboxControl: { jukeboxStatus: { currentIndex: 0, playing: true, gain: 0.9 } },
  });
  try {
    await jukebox.onPoll(fake, jukeboxConfig);
  } finally {
    mock.restore();
  }
  assert.deepEqual(fake.published, [
    { featureExternalId: 'jukebox:music-example-com:playback-state', state: 1 },
    { featureExternalId: 'jukebox:music-example-com:volume', state: 90 },
  ]);
});

test('jukebox_play_playlist queues the matched playlist and starts playback', async () => {
  const actions = [];
  const mock = mockSubsonicFetch({
    getPlaylists: { playlists: { playlist: [{ id: 'pl-1', name: 'Chill' }] } },
    getPlaylist: { playlist: { id: 'pl-1', name: 'Chill', entry: [{ id: 's1' }, { id: 's2' }] } },
    jukeboxControl: (url) => {
      actions.push({
        action: url.searchParams.get('action'),
        ids: url.searchParams.getAll('id'),
      });
      return { jukeboxStatus: { playing: true } };
    },
  });
  try {
    const message = await jukebox.actions.jukebox_play_playlist(gladys, {
      fields: { playlist: 'chill' },
      config: jukeboxConfig,
    });
    assert.match(message.en, /Chill/);
    assert.match(message.fr, /2 morceaux/);
  } finally {
    mock.restore();
  }
  assert.deepEqual(
    actions.map((a) => a.action),
    ['clear', 'add', 'start'],
  );
  assert.deepEqual(actions[1].ids, ['s1', 's2']);
});

test('the jukebox actions refuse to run while the toggle is off', async () => {
  const message = await jukebox.actions.jukebox_play_random(gladys, {
    fields: {},
    config: baseConfig,
  });
  assert.match(message.en, /Enable the jukebox/);
  assert.ok(message.fr, 'the message is multi-language');
});
