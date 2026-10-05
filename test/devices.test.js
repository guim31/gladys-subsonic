import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  activeBlueprints,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import {
  server,
  serverPlatformId,
  formatNowPlaying,
  resetLibraryCache,
  readNowPlaying,
  NOW_PLAYING_MAX_AGE_MS,
} from '../src/devices/server.js';
import { jukebox, skipQueue, playRandom } from '../src/devices/jukebox.js';
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

test('every published feature carries the fields Gladys stores as NOT NULL', () => {
  // min/max are NOT NULL columns of t_device_feature, whatever the category:
  // omitting them on a single feature makes Gladys reject the WHOLE device
  // with a 422, and the Discovery screen shows "appareil incomplete".
  for (const device of buildDiscoveredDevices(gladys, jukeboxConfig)) {
    for (const feature of device.features) {
      assert.equal(typeof feature.name, 'string', `${feature.external_id} needs a name`);
      assert.equal(typeof feature.min, 'number', `${feature.external_id} needs a min`);
      assert.equal(typeof feature.max, 'number', `${feature.external_id} needs a max`);
      assert.equal(typeof feature.read_only, 'boolean', `${feature.external_id} needs read_only`);
      assert.equal(
        typeof feature.has_feedback,
        'boolean',
        `${feature.external_id} needs has_feedback`,
      );
      assert.equal(
        typeof feature.keep_history,
        'boolean',
        `${feature.external_id} needs keep_history`,
      );
    }
  }
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

test('the server device carries read-only counters plus the now-playing text', () => {
  const device = server.buildDevice(gladys, baseConfig);
  // 60 s in config -> 60000 ms, one of the values Gladys accepts.
  assert.equal(device.poll_frequency, 60000);

  const counters = device.features.filter(
    (f) => f.category === DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
  );
  assert.equal(counters.length, 4, 'streams, songs, artists and albums');
  for (const feature of counters) {
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
    assert.equal(feature.read_only, true);
  }

  const text = device.features.find((f) => f.category === DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(text.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(text.read_only, true);
  // Gladys keeps no history for text states, only the feature's last value.
  assert.equal(text.keep_history, false);
});

test('formatNowPlaying summarizes the streams in one line', () => {
  assert.equal(formatNowPlaying([]), 'Nothing playing');
  assert.equal(
    formatNowPlaying([{ artist: 'Radiohead', title: 'Karma Police', username: 'guilhem' }]),
    'Radiohead — Karma Police (guilhem)',
  );
  assert.equal(
    formatNowPlaying([
      { artist: 'Radiohead', title: 'Karma Police' },
      { artist: 'Air', title: 'Sexy Boy' },
    ]),
    'Radiohead — Karma Police +1 more',
  );
  // A stream missing its tags must not render "undefined".
  assert.equal(formatNowPlaying([{ username: 'guilhem' }]), 'Unknown track (guilhem)');
});

// Routes of a small library, reused by the polling tests below.
const LIBRARY_ROUTES = {
  getNowPlaying: {
    nowPlaying: { entry: [{ artist: 'Air', title: 'Sexy Boy', coverArt: 'al-1' }, { id: 'b' }] },
  },
  getCoverArt: { __image: 'fake-jpeg-bytes', __mime: 'image/jpeg' },
  getScanStatus: { scanStatus: { scanning: false, count: 4242 } },
  getArtists: {
    artists: {
      index: [
        { name: 'A', artist: [{ id: '1', albumCount: 3 }] },
        // Single child returned as an object, not an array (XML heritage).
        { name: 'B', artist: { id: '2', albumCount: 2 } },
      ],
    },
  },
};

test('server onPoll publishes streams, now playing and the library counts', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch(LIBRARY_ROUTES);
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const byFeature = Object.fromEntries(
    fake.published.map((p) => [p.featureExternalId, p.state ?? p.text]),
  );
  assert.equal(byFeature['server:music-example-com:active-streams'], 2);
  assert.equal(byFeature['server:music-example-com:now-playing'], 'Air — Sexy Boy +1 more');
  assert.equal(byFeature['server:music-example-com:song-count'], 4242);
  assert.equal(byFeature['server:music-example-com:artist-count'], 2);
  assert.equal(byFeature['server:music-example-com:album-count'], 5);
});

test('a session left in the list after playback stopped is not counted', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    // Navidrome keeps a stopped or paused session in its now playing list
    // (30 minutes), so only the reported state tells music apart from
    // leftovers.
    getNowPlaying: {
      nowPlaying: {
        entry: [
          { artist: 'Air', title: 'Sexy Boy', coverArt: 'al-1', state: 'stopped' },
          { artist: 'Air', title: 'La Femme', coverArt: 'al-2', state: 'paused' },
        ],
      },
    },
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const byFeature = Object.fromEntries(
    fake.published.map((p) => [p.featureExternalId, p.state ?? p.text]),
  );
  assert.equal(byFeature['server:music-example-com:active-streams'], 0);
  assert.equal(byFeature['server:music-example-com:now-playing'], 'Nothing playing');
});

test('a server reporting no playback state keeps every listed session', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    // Plain Subsonic servers send no `state` at all: listing an entry is the
    // most they can tell us, so it must still count.
    getNowPlaying: { nowPlaying: { entry: [{ artist: 'Air', title: 'Sexy Boy' }] } },
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const byFeature = Object.fromEntries(
    fake.published.map((p) => [p.featureExternalId, p.state ?? p.text]),
  );
  assert.equal(byFeature['server:music-example-com:active-streams'], 1);
  assert.equal(byFeature['server:music-example-com:now-playing'], 'Air — Sexy Boy');
});

test('a scan refused for lack of rights is reported as an error, not a success', async () => {
  const mock = mockSubsonicFetch({
    startScan: { status: 'failed', error: { code: 50, message: 'User is not authorized' } },
  });
  try {
    // Gladys paints a returned message green: a refusal must throw so it
    // shows up red, and must say why in both languages (a thrown message
    // reaches the screen as a plain string).
    await assert.rejects(
      () => server.actions.start_scan(gladys, { config: baseConfig }),
      (err) =>
        /reserved to administrators/.test(err.message) &&
        /réservé aux administrateurs/.test(err.message) &&
        err.cause?.code === 50,
    );
  } finally {
    mock.restore();
  }
});

test('the cover art is published on the image channel, once per track', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  let coverArt = 'al-1';
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getNowPlaying: () => ({
      nowPlaying: { entry: [{ artist: 'Air', title: 'Sexy Boy', coverArt }] },
    }),
  });
  try {
    await server.onPoll(fake, baseConfig);
    await server.onPoll(fake, baseConfig); // same track: nothing new to send
    coverArt = 'al-2'; // track changed
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }

  assert.equal(fake.cameraImages.length, 2, 'one image per distinct cover, not per poll');
  assert.equal(fake.cameraImages[0].deviceExternalId, 'server:music-example-com');
  // The dashboard renders the string as `data:<image>`, so it must carry its
  // own mime type and stay under the 150 KB the core accepts.
  assert.match(fake.cameraImages[0].image, /^image\/jpeg;base64,/);
  assert.ok(fake.cameraImages[0].image.length <= 150 * 1024);
  assert.deepEqual(
    mock.calls.filter((c) => c.endpoint === 'getCoverArt').map((c) => c.url.searchParams.get('id')),
    ['al-1', 'al-2'],
  );
});

test('a placeholder cover is published when nothing has ever been played', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getNowPlaying: {}, // nobody is listening
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  // Without this the camera feature holds no value at all and the widget
  // renders a broken image.
  assert.equal(fake.cameraImages.length, 1);
  assert.match(fake.cameraImages[0].image, /^image\/svg\+xml;base64,/);
  assert.equal(
    mock.calls.filter((c) => c.endpoint === 'getCoverArt').length,
    0,
    'the placeholder costs no request to the server',
  );
});

test('the last cover stays on screen when playback stops', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  let playing = true;
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getNowPlaying: () =>
      playing ? { nowPlaying: { entry: [{ title: 'Sexy Boy', coverArt: 'al-1' }] } } : {},
  });
  try {
    await server.onPoll(fake, baseConfig);
    playing = false;
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  // One real cover, and no placeholder replacing it: the widget keeps
  // showing what was played last.
  assert.equal(fake.cameraImages.length, 1);
  assert.match(fake.cameraImages[0].image, /^image\/jpeg;base64,/);
});

test('the current image is re-sent before Gladys expires it', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch(LIBRARY_ROUTES);
  const realNow = Date.now;
  try {
    await server.onPoll(fake, baseConfig);
    assert.equal(fake.cameraImages.length, 1);
    // Same track 15 minutes later: Gladys drops a camera image after an
    // hour, so the same bytes must be re-sent rather than left to expire.
    Date.now = () => realNow() + 15 * 60 * 1000;
    await server.onPoll(fake, baseConfig);
  } finally {
    Date.now = realNow;
    mock.restore();
  }
  assert.equal(fake.cameraImages.length, 2, 'the image is refreshed on its own');
  assert.equal(fake.cameraImages[0].image, fake.cameraImages[1].image);
  assert.equal(
    mock.calls.filter((c) => c.endpoint === 'getCoverArt').length,
    1,
    're-sending must not re-download the cover',
  );
});

test('a cover art that cannot be fetched never breaks the poll', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getCoverArt: { status: 'failed', error: { code: 70, message: 'not found' } },
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  // An album with no artwork must not leave the widget with a broken image:
  // the placeholder takes over when there is nothing else on screen.
  assert.equal(fake.cameraImages.length, 1);
  assert.match(fake.cameraImages[0].image, /^image\/svg\+xml;base64,/);
  // The sensors of the same poll went through regardless.
  assert.ok(
    fake.published.some((p) => p.featureExternalId === 'server:music-example-com:now-playing'),
  );
});

test('onGetImage answers with the cover of what is playing right now', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch(LIBRARY_ROUTES);
  let image;
  try {
    image = await server.onGetImage(fake, { device: {}, config: baseConfig });
  } finally {
    mock.restore();
  }
  assert.match(image, /^image\/jpeg;base64,/);
});

test('the heavy artist list is fetched once while the library is unchanged', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch(LIBRARY_ROUTES);
  try {
    await server.onPoll(fake, baseConfig);
    await server.onPoll(fake, baseConfig);
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const calls = mock.calls.filter((c) => c.endpoint === 'getArtists');
  assert.equal(calls.length, 1, 'getArtists must be served from the cache after the first poll');
  // ...and the counts are still published on every poll, so the dashboard
  // never goes stale.
  const albums = fake.published.filter(
    (p) => p.featureExternalId === 'server:music-example-com:album-count',
  );
  assert.equal(albums.length, 3);
  assert.deepEqual(
    albums.map((p) => p.state),
    [5, 5, 5],
  );
});

test('a changed scan signature re-reads the artist list', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  let songCount = 4242;
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getScanStatus: () => ({ scanStatus: { scanning: false, count: songCount } }),
  });
  try {
    await server.onPoll(fake, baseConfig);
    songCount = 4300; // a scan added files: the counts may have moved
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.filter((c) => c.endpoint === 'getArtists').length, 2);
});

test('a server refusing getScanStatus still publishes what it can', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch({
    ...LIBRARY_ROUTES,
    getScanStatus: { status: 'failed', error: { code: 50, message: 'not authorized' } },
  });
  try {
    await server.onPoll(fake, baseConfig);
  } finally {
    mock.restore();
  }
  const ids = fake.published.map((p) => p.featureExternalId);
  assert.ok(
    ids.includes('server:music-example-com:artist-count'),
    'library counts still published',
  );
  assert.ok(
    !ids.includes('server:music-example-com:song-count'),
    'an unmeasured song count must not be published as 0',
  );
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

// --- Dashboard widgets: the data behind them and their buttons ---------------

test('the now playing list read by the poll is reused by the widget while fresh', async () => {
  resetLibraryCache();
  const fake = createFakeGladys();
  const mock = mockSubsonicFetch(LIBRARY_ROUTES);
  const realNow = Date.now;
  try {
    await server.onPoll(fake, baseConfig);
    const entries = await readNowPlaying(baseConfig);
    assert.equal(entries.length, 2);
    assert.equal(
      mock.calls.filter((c) => c.endpoint === 'getNowPlaying').length,
      1,
      'the widget reuses what the poll just read',
    );
    // Past the widget freshness: read again.
    Date.now = () => realNow() + NOW_PLAYING_MAX_AGE_MS + 1;
    await readNowPlaying(baseConfig);
    assert.equal(mock.calls.filter((c) => c.endpoint === 'getNowPlaying').length, 2);
    // ...and the poll always reads, then refreshes the cache for the widget.
    await server.onPoll(fake, baseConfig);
    await readNowPlaying(baseConfig);
    assert.equal(mock.calls.filter((c) => c.endpoint === 'getNowPlaying').length, 3);
  } finally {
    Date.now = realNow;
    mock.restore();
  }
  // Another server never gets the cached list of the first one.
  resetLibraryCache();
  const other = mockSubsonicFetch({ getNowPlaying: {} });
  try {
    assert.deepEqual(
      await readNowPlaying(normalizeConfig({ ...baseConfig, server_url: 'http://other' })),
      [],
    );
  } finally {
    other.restore();
  }
});

test('the library widget scan button starts a scan and reports it', async () => {
  const mock = mockSubsonicFetch({ startScan: { scanStatus: { scanning: true, count: 12 } } });
  try {
    const message = await server.widgetAction(gladys, { actionKey: 'scan', config: baseConfig });
    assert.match(message.fr, /^Scan de la bibliothèque en cours \(12 éléments/);
    assert.ok(message.en.length <= 200 && message.fr.length <= 200, 'a toast is 200 chars max');
  } finally {
    mock.restore();
  }
  // A refusal thrown from the widget is a toast too: short, in both
  // languages, where the configuration button keeps its long explanation.
  const refused = mockSubsonicFetch({
    startScan: { status: 'failed', error: { code: 50, message: 'User is not authorized' } },
  });
  try {
    await assert.rejects(
      () => server.widgetAction(gladys, { actionKey: 'scan', config: baseConfig }),
      (err) =>
        err.message.length <= 200 &&
        /administrators only/.test(err.message) &&
        /réservé aux administrateurs/.test(err.message) &&
        err.cause?.code === 50,
    );
    await assert.rejects(
      () => server.actions.start_scan(gladys, { config: baseConfig }),
      (err) => err.message.length > 200 && /reserved to administrators/.test(err.message),
    );
  } finally {
    refused.restore();
  }
  const failed = mockSubsonicFetch({
    startScan: { status: 'failed', error: { code: 0, message: 'boom' } },
  });
  try {
    await assert.rejects(
      () => server.widgetAction(gladys, { actionKey: 'scan', config: baseConfig }),
      /Scan not started: Subsonic error 0: boom \/ Scan non lancé/,
    );
  } finally {
    failed.restore();
  }
  await assert.rejects(
    () => server.widgetAction(gladys, { actionKey: 'bogus', config: baseConfig }),
    /Unknown widget action/,
  );
  await assert.rejects(
    () => server.widgetAction(gladys, { actionKey: 'scan', config: normalizeConfig() }),
    /not configured/,
  );
});

/** A jukebox server stub recording the actions, with a queue of three tracks. */
function jukeboxServer({ playing = true, songs = 3 } = {}) {
  const actions = [];
  const state = { playing, currentIndex: 1 };
  const mock = mockSubsonicFetch({
    jukeboxControl: (url) => {
      // Only the jukebox parameters, not the auth ones.
      const params = Object.fromEntries(
        [...url.searchParams].filter(([key]) => ['action', 'index', 'id', 'gain'].includes(key)),
      );
      actions.push(params);
      switch (params.action) {
        case 'get':
          return {
            jukeboxPlaylist: {
              ...state,
              entry: Array.from({ length: songs }, (_, i) => ({ id: i })),
            },
          };
        case 'start':
          state.playing = true;
          break;
        case 'stop':
          state.playing = false;
          break;
        case 'skip':
          state.playing = true;
          state.currentIndex = Number(params.index);
          break;
        default:
          break;
      }
      return { jukeboxStatus: { ...state, gain: 0.5 } };
    },
    getRandomSongs: { randomSongs: { song: [{ id: 'r1' }, { id: 'r2' }] } },
  });
  return { actions, state, restore: mock.restore };
}

test('jukebox widget toggle reads the state at tap time and publishes the new one', async () => {
  const fake = createFakeGladys();
  const srv = jukeboxServer({ playing: true });
  try {
    await jukebox.widgetAction(fake, { actionKey: 'toggle', config: jukeboxConfig });
    assert.deepEqual(
      srv.actions.map((a) => a.action),
      ['status', 'stop'],
    );
    await jukebox.widgetAction(fake, { actionKey: 'toggle', config: jukeboxConfig });
    assert.deepEqual(srv.actions.map((a) => a.action).slice(2), ['status', 'start']);
  } finally {
    srv.restore();
  }
  assert.deepEqual(fake.published, [
    { featureExternalId: 'jukebox:music-example-com:playback-state', state: 0 },
    { featureExternalId: 'jukebox:music-example-com:playback-state', state: 1 },
  ]);
});

test('jukebox widget previous/next skip in the queue, refused past its ends', async () => {
  const fake = createFakeGladys();
  const srv = jukeboxServer();
  try {
    await jukebox.widgetAction(fake, { actionKey: 'next', config: jukeboxConfig });
    assert.deepEqual(srv.actions.at(-1), { action: 'skip', index: '2' });
    await assert.rejects(
      () => jukebox.widgetAction(fake, { actionKey: 'next', config: jukeboxConfig }),
      /No track at position 3/,
    );
    await jukebox.widgetAction(fake, { actionKey: 'previous', config: jukeboxConfig });
    assert.deepEqual(srv.actions.at(-1), { action: 'skip', index: '1' });
    // The device features share the same helper.
    srv.state.currentIndex = 0;
    await assert.rejects(() => skipQueue(jukeboxConfig, -1), /No track at position -1/);
  } finally {
    srv.restore();
  }
  // A skip starts playing: the state Gladys shows follows.
  assert.deepEqual(
    fake.published.map((p) => p.state),
    [1, 1],
  );
});

test('jukebox widget shuffle queues random songs, like the configuration action', async () => {
  const fake = createFakeGladys();
  const srv = jukeboxServer({ playing: false });
  try {
    const message = await jukebox.widgetAction(fake, {
      actionKey: 'random',
      config: jukeboxConfig,
    });
    assert.equal(message.fr, 'Lecture de 2 morceaux aléatoires sur le jukebox.');
    assert.deepEqual(
      srv.actions.map((a) => a.action),
      ['clear', 'add', 'start'],
    );
    assert.deepEqual(srv.actions[1], { action: 'add', id: 'r2' }, 'the add call carries the ids');
    assert.deepEqual(
      await jukebox.actions.jukebox_play_random(fake, { fields: {}, config: jukeboxConfig }),
      message,
    );
  } finally {
    srv.restore();
  }
  assert.deepEqual(fake.published[0], {
    featureExternalId: 'jukebox:music-example-com:playback-state',
    state: 1,
  });

  // An empty library leaves the queue alone and says so.
  const empty = mockSubsonicFetch({ getRandomSongs: {} });
  try {
    assert.deepEqual(await playRandom(jukeboxConfig, 20), { queued: 0, status: null });
    const message = await jukebox.widgetAction(fake, {
      actionKey: 'random',
      config: jukeboxConfig,
    });
    assert.match(message.en, /no songs/);
    assert.equal(empty.calls.length, 2, 'getRandomSongs only, no clear/add/start');
  } finally {
    empty.restore();
  }
});

test('a refused state publication never fails a jukebox button that acted', async () => {
  // The jukebox device was never added to Gladys: the core refuses the
  // state (the SDK throws), but the jukebox DID start playing.
  const fake = createFakeGladys();
  fake.publishState = async () => {
    throw new Error('HTTP 404: device feature not found');
  };
  const srv = jukeboxServer({ playing: false });
  try {
    await jukebox.widgetAction(fake, { actionKey: 'toggle', config: jukeboxConfig });
    assert.deepEqual(
      srv.actions.map((a) => a.action),
      ['status', 'start'],
    );
    await jukebox.widgetAction(fake, { actionKey: 'next', config: jukeboxConfig });
    const message = await jukebox.widgetAction(fake, {
      actionKey: 'random',
      config: jukeboxConfig,
    });
    assert.match(message.fr, /^Lecture de 2 morceaux/);
  } finally {
    srv.restore();
  }
});

test('jukebox widget buttons refuse to run while the jukebox is disabled', async () => {
  const fake = createFakeGladys();
  await assert.rejects(
    () => jukebox.widgetAction(fake, { actionKey: 'toggle', config: baseConfig }),
    (err) =>
      err.message.length <= 200 &&
      /Jukebox not enabled\. \/ Jukebox non activé\./.test(err.message),
  );
  await assert.rejects(
    () => jukebox.widgetAction(fake, { actionKey: 'bogus', config: jukeboxConfig }),
    /Unknown widget action/,
  );
  assert.deepEqual(fake.published, []);
});
