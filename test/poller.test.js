import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../src/poller.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { resetLibraryCache } from '../src/devices/server.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, mockSubsonicFetch, ID_PREFIX } from './helpers/fakeGladys.js';

const config = normalizeConfig({
  server_url: 'https://music.example.com',
  username: 'admin',
  password: 'sesame',
  jukebox_enabled: true,
});
const SERVER_ID = `${ID_PREFIX}server:music-example-com`;

let coverArt;
let title;
let failing;
const ROUTES = {
  getNowPlaying: () =>
    failing
      ? { status: 'failed', error: { code: 0, message: 'server unavailable' } }
      : { nowPlaying: { entry: [{ artist: 'Air', title, coverArt }] } },
  getCoverArt: { __image: 'fake-jpeg-bytes', __mime: 'image/jpeg' },
  getScanStatus: { scanStatus: { scanning: false, count: 4242 } },
  getArtists: { artists: { index: [{ name: 'A', artist: [{ id: '1', albumCount: 3 }] }] } },
  jukeboxControl: { jukeboxStatus: { playing: false, gain: 0.5, currentIndex: 0 } },
};

beforeEach(() => {
  resetLibraryCache();
  coverArt = 'al-1';
  title = 'Sexy Boy';
  failing = false;
});

/** Let the poll started by a fired timer run to its end. */
async function settle() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A connected fake Gladys where the user added the server device only (the
 * jukebox is enabled in the config but its device was never added).
 */
async function setup(t, { timers = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  const probe = createFakeGladys();
  const [serverDevice] = buildDiscoveredDevices(probe, config);
  const gladys = createFakeGladys({ config, devices: [serverDevice] });
  await gladys.connect();
  const mock = mockSubsonicFetch(ROUTES);
  t.after(() => mock.restore());
  const poller = createPoller({ gladys, getConfig: () => config, timers });
  poller.register();
  t.after(() => poller.stop());
  const reads = () => mock.calls.filter((c) => c.endpoint === 'getNowPlaying').length;
  return { gladys, poller, mock, lines, reads, serverDevice };
}

test('the container polls an added device by itself, every period (Gladys#3198)', async (t) => {
  const { gladys, poller, mock, reads } = await setup(t);

  await poller.restart();
  assert.equal(reads(), 1, 'polled at once');
  assert.equal(gladys.fake.lastState(`${SERVER_ID}:active-streams`), 1);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(reads(), 2, 'polled again after one period, without any onPoll from the core');

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(reads(), 3);

  assert.equal(
    mock.calls.filter((c) => c.endpoint === 'jukeboxControl').length,
    0,
    'a device the user never added is not polled',
  );
});

test("the core's onPoll is a fallback: it never reads the server twice in a period", async (t) => {
  const { gladys, poller, reads, serverDevice } = await setup(t);
  await poller.restart();
  assert.equal(reads(), 1);

  // The core asks 10 s after the timer: already done.
  t.mock.timers.tick(10_000);
  assert.deepEqual(await gladys.fake.poll(serverDevice), { success: true });
  assert.equal(reads(), 1);

  // 40 s after the timer, more than half a period: the core's poll runs...
  t.mock.timers.tick(30_000);
  assert.deepEqual(await gladys.fake.poll(serverDevice), { success: true });
  assert.equal(reads(), 2);

  // ...and the timer, firing 20 s later, skips it.
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(reads(), 2);

  // The next period is the timer's again.
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(reads(), 3);
});

test("the core's onPoll still polls on its own", async (t) => {
  const { gladys, reads, serverDevice } = await setup(t, { timers: false });
  assert.deepEqual(await gladys.fake.poll(serverDevice), { success: true });
  assert.equal(reads(), 1);
  assert.equal(gladys.fake.lastState(`${SERVER_ID}:now-playing`), 'Air — Sexy Boy');
});

test('only the values that changed are published again', async (t) => {
  const { gladys, poller } = await setup(t);
  await poller.restart();
  const first = gladys.fake.states.length;
  assert.ok(first >= 5);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(gladys.fake.states.length, first, 'nothing changed, nothing sent');

  coverArt = 'al-2';
  title = 'La Femme';
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(
    gladys.fake.states.slice(first).map((s) => s.text ?? s.state),
    ['Air — La Femme'],
  );
});

test('a device just added gets all its states at once', async (t) => {
  const { gladys, poller, reads, serverDevice } = await setup(t);
  await poller.restart();
  const first = gladys.fake.states.length;

  // Seconds later, the user adds it again (deleted then re-created): the SDK
  // forgot what it sent, the poller sends everything, timer or not.
  t.mock.timers.tick(5_000);
  await gladys.fake.deviceCreated(serverDevice);
  assert.equal(reads(), 2);
  assert.equal(gladys.fake.states.length, first * 2);
});

test('a failing server is said once, and its return once', async (t) => {
  const { poller, lines } = await setup(t);
  failing = true;
  await poller.restart();
  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(60_000);
    await settle();
  }
  const warnings = lines.filter((l) => l.includes('[WARN]'));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /server: polling failed \(.*server unavailable/);

  failing = false;
  t.mock.timers.tick(60_000);
  await settle();
  t.mock.timers.tick(60_000);
  await settle();
  const infos = lines.filter((l) => l.includes('[INFO]'));
  assert.equal(infos.length, 1, infos.join('\n'));
  assert.match(infos[0], /server: polling works again/);
});

test('a normal polling cycle writes nothing at info level', async (t) => {
  const previous = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL; // the default: info
  t.after(() => {
    if (previous !== undefined) {
      process.env.LOG_LEVEL = previous;
    }
  });
  const { poller, lines } = await setup(t);
  await poller.restart();
  coverArt = 'al-2'; // a track change: new states, a new cover
  t.mock.timers.tick(60_000);
  await settle();
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(lines, [], 'no line at info level or above');
});
