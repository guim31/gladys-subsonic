// The Gladys 5.3 music player: the jukebox's now playing (publishNowPlaying),
// its writable controls, and the catalog of the music panel.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_PLAYBACK_STATE, validateMediaItems } from '@gladysassistant/integration-sdk';
import {
  jukebox,
  publishJukebox,
  resetJukeboxState,
  setJukeboxFollowUp,
} from '../src/devices/jukebox.js';
import { serverPlatformId } from '../src/devices/server.js';
import {
  createCatalog,
  parseMediaId,
  ROOTS,
  ADD_CHUNK,
  MAX_TAIL_REMOVALS,
  artworkSource,
} from '../src/catalog.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys, mockSubsonicFetch } from './helpers/fakeGladys.js';

const config = normalizeConfig({
  server_url: 'https://music.example.com',
  username: 'admin',
  password: 'sesame',
  jukebox_enabled: true,
});
const DEVICE = 'ext:test-integration:jukebox:music-example-com';
const id = (key) => `${DEVICE}:${key}`;

const SONGS = [
  {
    id: 's1',
    title: 'First Light',
    artist: 'Aurora Lane',
    album: 'Morning Light',
    coverArt: 'al-1_abc',
    duration: 40,
  },
  { id: 's2', title: 'Golden Hour', artist: 'Aurora Lane', album: 'Morning Light', duration: 41 },
  { id: 's3', title: 'Dew', artist: 'Aurora Lane', album: 'Morning Light', duration: 30 },
];

/**
 * A jukebox that behaves like Navidrome's: `skip` keeps playing or paused,
 * `stop` pauses, `remove` leaves the current song playing.
 */
function navidromeJukebox({
  queue = SONGS.map((s) => ({ ...s })),
  index = 0,
  playing = true,
} = {}) {
  const state = { queue, index, playing, position: 12, gain: 0.5 };
  const actions = [];
  const status = () => ({
    currentIndex: state.index,
    playing: state.playing,
    gain: state.gain,
    position: state.position,
  });
  const library = new Map(SONGS.map((s) => [s.id, s]));
  const mockFetch = mockSubsonicFetch({
    jukeboxControl: (url) => {
      const action = url.searchParams.get('action');
      const ids = url.searchParams.getAll('id');
      actions.push({ action, ids, index: url.searchParams.get('index') });
      switch (action) {
        case 'get':
          return { jukeboxPlaylist: { ...status(), entry: state.queue } };
        case 'start':
          state.playing = state.queue.length > 0;
          break;
        case 'stop':
          state.playing = false;
          break;
        case 'skip':
          state.index = Number(url.searchParams.get('index'));
          state.position = Number(url.searchParams.get('offset') ?? 0);
          break;
        case 'clear':
          state.queue = [];
          state.index = -1;
          state.playing = false;
          break;
        case 'set':
          state.queue = [];
          state.index = -1;
          state.playing = false;
        // falls through
        case 'add':
          for (const songId of ids) {
            if (!library.has(songId)) {
              return { status: 'failed', error: { code: 70, message: 'not found' } };
            }
          }
          state.queue.push(...ids.map((songId) => ({ ...library.get(songId) })));
          if (state.index === -1 && state.queue.length > 0) {
            state.index = 0;
          }
          break;
        case 'remove':
          state.queue.splice(Number(url.searchParams.get('index')), 1);
          break;
        case 'setGain':
          state.gain = Number(url.searchParams.get('gain'));
          break;
        default:
          break;
      }
      return { jukeboxStatus: status() };
    },
    getSong: (url) => {
      const song = library.get(url.searchParams.get('id'));
      return song ? { song } : { status: 'failed', error: { code: 70, message: 'Song not found' } };
    },
    getAlbum: (url) =>
      url.searchParams.get('id') === 'al-1'
        ? { album: { id: 'al-1', name: 'Morning Light', song: SONGS } }
        : { status: 'failed', error: { code: 70, message: 'Album not found' } },
    getArtist: () => ({
      artist: { id: 'ar-1', name: 'Aurora Lane', album: [{ id: 'al-1', name: 'Morning Light' }] },
    }),
  });
  return { state, actions, restore: mockFetch.restore, library };
}

async function connectedGladys() {
  const fake = createFakeGladys({ devices: [{ external_id: DEVICE, features: [] }] });
  await fake.connect();
  resetJukeboxState();
  return fake;
}

const lastText = (fake, key) =>
  fake.published.filter((p) => p.featureExternalId === id(key)).at(-1)?.text;
const lastState = (fake, key) =>
  fake.published.filter((p) => p.featureExternalId === id(key)).at(-1)?.state;

test('a playing song is published whole, the 1.x ids kept for state and volume', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox();
  try {
    await jukebox.onPoll(fake, config);
  } finally {
    jb.restore();
  }
  assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PLAYING);
  assert.equal(lastText(fake, 'title'), 'First Light');
  assert.equal(lastText(fake, 'artist'), 'Aurora Lane');
  assert.equal(lastText(fake, 'album'), 'Morning Light');
  assert.match(lastText(fake, 'artwork'), /^art-[0-9a-f]{12}$/);
  assert.equal(lastState(fake, 'duration'), 40);
  assert.equal(lastState(fake, 'position'), 12);
  assert.equal(lastState(fake, 'volume'), 50);
  assert.equal(
    fake.published.some((p) => p.featureExternalId === id('playback_state')),
    false,
    'never a second playback state id',
  );
});

test('the queue is read once while the index stays, again when it moves', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox();
  try {
    await jukebox.onPoll(fake, config);
    await jukebox.onPoll(fake, config);
    assert.deepEqual(
      jb.actions.map((a) => a.action),
      ['status', 'get', 'status'],
    );
    const before = fake.published.length;
    jb.state.index = 1;
    jb.state.position = 0;
    await jukebox.onPoll(fake, config);
    assert.deepEqual(jb.actions.map((a) => a.action).slice(3), ['status', 'get']);
    const batch = fake.published.slice(before).map((p) => p.featureExternalId);
    assert.ok(batch.includes(id('title')) && batch.includes(id('position')));
    assert.equal(lastText(fake, 'title'), 'Golden Hour');
    // No cover on this song: the artwork is cleared, not left on the last one.
    assert.equal(lastText(fake, 'artwork'), '');
  } finally {
    jb.restore();
  }
});

test('an empty jukebox is IDLE with its texts cleared explicitly', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox({ queue: [], index: -1, playing: false });
  try {
    await jukebox.onPoll(fake, config);
  } finally {
    jb.restore();
  }
  assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.IDLE);
  for (const key of ['title', 'artist', 'album', 'artwork']) {
    assert.equal(lastText(fake, key), '', key);
  }
  assert.equal(lastState(fake, 'duration'), 0);
});

test('playback state writes: 0 pauses, 1 plays, 2 stops at the start of the song', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox();
  const feature = jukebox
    .buildDevice(fake, config)
    .features.find((f) => f.type === 'playback_state');
  const write = (value) =>
    jukebox.onSetValue(fake, { device: { external_id: DEVICE }, feature, value, config });
  try {
    await write(0);
    assert.equal(jb.state.playing, false);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PAUSED);
    await write(1);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PLAYING);
    await write(2);
    assert.deepEqual(
      jb.actions.slice(-3).map((a) => a.action),
      ['stop', 'skip', 'get'],
    );
    assert.equal(jb.state.position, 0);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.IDLE);
    // Still stopped at the next poll; playing again clears it.
    await jukebox.onPoll(fake, config);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.IDLE);
    jb.state.playing = true;
    await jukebox.onPoll(fake, config);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PLAYING);
    await assert.rejects(() => write(3), /play, pause or stop/);
  } finally {
    jb.restore();
  }
});

test('the end of the queue is IDLE, a pause on the last song is not', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox({ index: 2 });
  try {
    await jukebox.onPoll(fake, config);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PLAYING);
    // Navidrome after the last song: still current, closed, not playing.
    jb.state.playing = false;
    jb.state.position = 0;
    await jukebox.onPoll(fake, config);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.IDLE);
    assert.equal(lastText(fake, 'title'), 'Dew', 'the last song stays shown');
    // A pause from Gladys in the first second of the last song.
    jb.state.playing = true;
    await jukebox.onPoll(fake, config);
    const feature = jukebox
      .buildDevice(fake, config)
      .features.find((f) => f.type === 'playback_state');
    await jukebox.onSetValue(fake, { device: {}, feature, value: 0, config });
    await jukebox.onPoll(fake, config);
    assert.equal(lastState(fake, 'playback-state'), MUSIC_PLAYBACK_STATE.PAUSED);
  } finally {
    jb.restore();
  }
});

test('a position write seeks in the current song, refused on an empty jukebox', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox({ index: 1 });
  const feature = jukebox.buildDevice(fake, config).features.find((f) => f.type === 'position');
  try {
    await jukebox.onSetValue(fake, { device: {}, feature, value: 25.6, config });
    const skip = jb.actions.find((a) => a.action === 'skip');
    assert.equal(skip.index, '1');
    assert.equal(jb.state.position, 26);
    assert.equal(lastState(fake, 'position'), 26);
  } finally {
    jb.restore();
  }
  const empty = navidromeJukebox({ queue: [], index: -1 });
  try {
    await assert.rejects(
      () => jukebox.onSetValue(fake, { device: {}, feature, value: 5, config }),
      /Nothing is loaded/,
    );
  } finally {
    empty.restore();
  }
});

test('a read is scheduled right after the end of the playing song', async () => {
  const fake = await connectedGladys();
  const jb = navidromeJukebox();
  mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  setJukeboxFollowUp(async () => {
    reads += 1;
  });
  try {
    await publishJukebox(fake, config); // 40 s song at 12 s: 28 s left
    mock.timers.tick(28_000);
    assert.equal(reads, 0);
    mock.timers.tick(1_600);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    // Paused: nothing scheduled.
    jb.state.playing = false;
    await publishJukebox(fake, config);
    mock.timers.tick(120_000);
    assert.equal(reads, 1);
  } finally {
    setJukeboxFollowUp(null);
    mock.timers.reset();
    jb.restore();
  }
});

// --- Catalog -------------------------------------------------------------------

function catalogFor(fake, overrides = {}) {
  let commands = 0;
  const catalog = createCatalog({
    gladys: fake,
    getConfig: () => ({ ...config, ...overrides }),
    platformId: () => serverPlatformId(config),
    isJukebox: (device) => device?.external_id === DEVICE,
    afterCommand: async () => {
      commands += 1;
    },
  });
  return { catalog, commands: () => commands };
}

const jukeboxDevice = { external_id: DEVICE };

test('the root offers three folders in the configured language', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const root = await catalog.browse(jukeboxDevice, { parentId: null, offset: 0, limit: 50 });
  assert.deepEqual(
    root.items.map((i) => i.title),
    ['Albums', 'Artistes', 'Playlists'],
  );
  assert.equal(root.total, 3);
  assert.deepEqual(validateMediaItems(root.items), []);
  const english = catalogFor(fake, { language: 'en' }).catalog;
  const items = (await english.browse(jukeboxDevice, { parentId: null })).items;
  assert.equal(items[1].title, 'Artists');
});

test('only the jukebox has a catalog', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const server = { external_id: 'ext:test-integration:server:music-example-com' };
  await assert.rejects(() => catalog.browse(server, { parentId: null }), /Seul le jukebox/);
  await assert.rejects(() => catalog.play(server, { id: 'track:s1' }, 'replace'), /Seul/);
  await assert.rejects(() => catalog.queueGet(server, {}), /Seul/);
});

test('albums are paged by the server, one more row announced while pages are full', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const albums = Array.from({ length: 5 }, (_, i) => ({
    id: `al-${i}`,
    name: `Album ${i}`,
    artist: 'Someone',
    coverArt: `al-${i}_x`,
  }));
  const requests = [];
  const m = mockSubsonicFetch({
    getAlbumList2: (url) => {
      const size = Number(url.searchParams.get('size'));
      const offset = Number(url.searchParams.get('offset'));
      requests.push({ size, offset, type: url.searchParams.get('type') });
      return { albumList2: { album: albums.slice(offset, offset + size) } };
    },
  });
  try {
    const first = await catalog.browse(jukeboxDevice, {
      parentId: ROOTS.albums,
      offset: 0,
      limit: 3,
    });
    assert.equal(first.items.length, 3);
    assert.equal(first.total, 4, 'a full page: one more is announced');
    assert.deepEqual(first.items[0], {
      id: 'album:al-0',
      type: 'album',
      title: 'Album 0',
      subtitle: 'Someone',
      duration: null,
      artwork_key: first.items[0].artwork_key,
      browsable: true,
      playable: true,
    });
    assert.match(first.items[0].artwork_key, /^art-[0-9a-f]{12}$/);
    const second = await catalog.browse(jukeboxDevice, {
      parentId: ROOTS.albums,
      offset: 3,
      limit: 3,
    });
    assert.equal(second.items.length, 2);
    assert.equal(second.total, 5);
    assert.equal(requests[0].type, 'alphabeticalByName');
    assert.deepEqual(validateMediaItems([...first.items, ...second.items]), []);
  } finally {
    m.restore();
  }
});

test('artists, playlists, an artist, an album and a playlist are browsed', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const jb = navidromeJukebox();
  const m = mockSubsonicFetch({
    getArtists: {
      artists: {
        index: [
          { name: 'A', artist: [{ id: 'ar-1', name: 'Aurora Lane', coverArt: 'ar-1_x' }] },
          { name: 'T', artist: { id: 'ar-2', name: 'The Quiet Ones' } },
        ],
      },
    },
    getPlaylists: { playlists: { playlist: [{ id: 'pl-1', name: 'Soir', owner: 'admin' }] } },
    getPlaylist: { playlist: { id: 'pl-1', name: 'Soir', entry: [SONGS[0], SONGS[2]] } },
    getArtist: { artist: { id: 'ar-1', album: [{ id: 'al-1', name: 'Morning Light' }] } },
    getAlbum: { album: { id: 'al-1', song: SONGS } },
  });
  try {
    const artists = await catalog.browse(jukeboxDevice, { parentId: ROOTS.artists, limit: 1 });
    assert.equal(artists.total, 2);
    assert.equal(artists.items[0].id, 'artist:ar-1');
    const playlists = await catalog.browse(jukeboxDevice, { parentId: ROOTS.playlists });
    assert.equal(playlists.items[0].subtitle, 'admin');
    const ofArtist = await catalog.browse(jukeboxDevice, { parentId: 'artist:ar-1' });
    assert.equal(ofArtist.items[0].type, 'album');
    const album = await catalog.browse(jukeboxDevice, {
      parentId: 'album:al-1',
      offset: 1,
      limit: 5,
    });
    assert.equal(album.total, 3);
    assert.deepEqual(
      album.items.map((i) => [i.id, i.type, i.duration, i.browsable]),
      [
        ['track:s2', 'track', 41, false],
        ['track:s3', 'track', 30, false],
      ],
    );
    const playlist = await catalog.browse(jukeboxDevice, { parentId: 'playlist:pl-1' });
    assert.equal(playlist.items[1].title, 'Dew');
    await assert.rejects(() => catalog.browse(jukeboxDevice, { parentId: 'track:s1' }), /ouvert/);
    await assert.rejects(() => catalog.browse(jukeboxDevice, { parentId: 'nonsense' }), /ouvert/);
    assert.deepEqual(validateMediaItems([...artists.items, ...album.items, ...playlist.items]), []);
  } finally {
    m.restore();
    jb.restore();
  }
});

test('an id gone from the library says so', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const jb = navidromeJukebox();
  try {
    await assert.rejects(
      () => catalog.browse(jukeboxDevice, { parentId: 'album:gone' }),
      /plus dans la bibliothèque/,
    );
  } finally {
    jb.restore();
  }
});

test('a row without an id is kept, as a neutral row', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const item = catalog.toMediaItem({ title: 'Ghost' }, 'track');
  assert.deepEqual(item, {
    id: 'other:unknown',
    type: 'track',
    title: 'Ghost',
    browsable: false,
    playable: false,
  });
});

test('search shares the limit between artists, albums, playlists and songs', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const counts = [];
  const many = (prefix, n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      name: `${prefix}${i}`,
      title: `${prefix}${i}`,
    }));
  const m = mockSubsonicFetch({
    search3: (url) => {
      counts.push(['artistCount', 'albumCount', 'songCount'].map((k) => url.searchParams.get(k)));
      return {
        searchResult3: { artist: many('ar', 1), album: many('al', 2), song: many('s', 20) },
      };
    },
    getPlaylists: {
      playlists: {
        playlist: [
          { id: 'p1', name: 'Morning mix' },
          { id: 'p2', name: 'Evening' },
        ],
      },
    },
  });
  try {
    const all = await catalog.search(jukeboxDevice, { query: 'MORNING', type: null, limit: 8 });
    assert.deepEqual(counts[0], ['8', '8', '8']);
    assert.deepEqual(
      all.items.map((i) => i.type),
      ['artist', 'album', 'album', 'playlist', 'track', 'track', 'track', 'track'],
    );
    assert.equal(all.items[3].title, 'Morning mix');
    const tracks = await catalog.search(jukeboxDevice, { query: 'x', type: 'track', limit: 5 });
    assert.deepEqual(counts[1], ['0', '0', '5']);
    assert.equal(tracks.items.length, 5);
    assert.deepEqual(await catalog.search(jukeboxDevice, { query: 'x', type: 'radio', limit: 5 }), {
      items: [],
    });
    assert.equal(counts.length, 2, 'no request for a radio');
  } finally {
    m.restore();
  }
});

test('play replace: songs read first, then clear, add, start', async () => {
  const fake = await connectedGladys();
  const { catalog, commands } = catalogFor(fake);
  const jb = navidromeJukebox();
  try {
    await catalog.play(jukeboxDevice, { id: 'album:al-1', type: 'album' }, 'replace');
    assert.deepEqual(
      jb.actions.map((a) => a.action),
      ['clear', 'add', 'start'],
    );
    assert.deepEqual(jb.actions[1].ids, ['s1', 's2', 's3']);
    assert.equal(commands(), 1, 'the new state is published at once');

    // A gone song: refused before anything is cleared.
    jb.actions.length = 0;
    await assert.rejects(
      () => catalog.play(jukeboxDevice, { id: 'track:gone', type: 'track' }, 'replace'),
      /plus dans la bibliothèque/,
    );
    assert.deepEqual(jb.actions, []);
    await assert.rejects(
      () => catalog.play(jukeboxDevice, { id: 'radio:1', type: 'radio' }, 'replace'),
      /ne peut pas jouer/,
    );
  } finally {
    jb.restore();
  }
});

test('an artist plays its albums, a long list goes in chunks', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const jb = navidromeJukebox();
  try {
    await catalog.play(jukeboxDevice, { id: 'artist:ar-1', type: 'artist' }, 'append');
    assert.deepEqual(
      jb.actions.map((a) => a.action),
      ['add'],
    );
    assert.equal(jb.state.queue.length, 6);
  } finally {
    jb.restore();
  }
  const many = Array.from({ length: ADD_CHUNK + 20 }, (_, i) => ({ id: `x${i}` }));
  const adds = [];
  const m = mockSubsonicFetch({
    getPlaylist: { playlist: { id: 'p', entry: many } },
    jukeboxControl: (url) => {
      if (url.searchParams.get('action') === 'add') {
        adds.push(url.searchParams.getAll('id').length);
      }
      return { jukeboxStatus: { currentIndex: 0, playing: true } };
    },
  });
  try {
    await catalog.play(jukeboxDevice, { id: 'playlist:p', type: 'playlist' }, 'replace');
    assert.deepEqual(adds, [ADD_CHUNK, 20]);
  } finally {
    m.restore();
  }
});

test('play next inserts after the current song, without stopping it', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const jb = navidromeJukebox({ index: 0 });
  try {
    await catalog.play(jukeboxDevice, { id: 'track:s3', type: 'track' }, 'next');
    assert.deepEqual(
      jb.state.queue.map((s) => s.id),
      ['s1', 's3', 's2', 's3'],
    );
    assert.equal(jb.state.index, 0);
    assert.equal(jb.state.playing, true);
    assert.equal(
      jb.actions.some((a) => ['set', 'clear', 'stop', 'skip'].includes(a.action)),
      false,
      'the current song plays on',
    );
  } finally {
    jb.restore();
  }
});

test('play next rebuilds the queue when the current song is queued twice', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const queue = ['s1', 's2', 's1', 's3'].map((songId) => ({
    ...SONGS.find((s) => s.id === songId),
  }));
  const jb = navidromeJukebox({ queue, index: 2 });
  try {
    await catalog.play(jukeboxDevice, { id: 'track:s2', type: 'track' }, 'next');
    assert.deepEqual(
      jb.state.queue.map((s) => s.id),
      ['s1', 's2', 's1', 's2', 's3'],
    );
    assert.equal(jb.state.index, 2, 'back on the same song');
    assert.equal(jb.state.position, 12, 'at the same second');
    assert.equal(jb.state.playing, true);
  } finally {
    jb.restore();
  }
  assert.ok(MAX_TAIL_REMOVALS >= 10);
});

test('play next on an empty queue appends', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const jb = navidromeJukebox({ queue: [], index: -1, playing: false });
  try {
    await catalog.play(jukeboxDevice, { id: 'track:s2', type: 'track' }, 'next');
    assert.deepEqual(
      jb.state.queue.map((s) => s.id),
      ['s2'],
    );
  } finally {
    jb.restore();
  }
});

test('the queue is paged without losing a row, and a tap plays the song', async () => {
  const fake = await connectedGladys();
  const { catalog, commands } = catalogFor(fake);
  const queue = [...SONGS, { title: 'no id' }].map((s) => ({ ...s }));
  const jb = navidromeJukebox({ queue, index: 2, playing: false });
  try {
    const page = await catalog.queueGet(jukeboxDevice, { offset: 1, limit: 10 });
    assert.equal(page.total, 4);
    assert.equal(page.currentIndex, 2);
    assert.equal(page.items.length, 3);
    assert.equal(page.items[2].id, 'other:unknown');
    await catalog.queuePlay(jukeboxDevice, 1);
    assert.deepEqual(
      jb.actions.slice(-2).map((a) => a.action),
      ['skip', 'start'],
    );
    assert.equal(jb.state.index, 1);
    assert.equal(jb.state.playing, true);
    assert.equal(commands(), 1);
    await assert.rejects(() => catalog.queuePlay(jukeboxDevice, 9), /plus dans la file/);
  } finally {
    jb.restore();
  }
  const empty = navidromeJukebox({ queue: [], index: -1, playing: false });
  try {
    const page = await catalog.queueGet(jukeboxDevice, { offset: 0, limit: 10 });
    assert.deepEqual(page, { items: [], currentIndex: null, total: 0 });
  } finally {
    empty.restore();
  }
});

test('artworks are asked at their size from the server, with the credentials', async () => {
  const fake = await connectedGladys();
  const { catalog } = catalogFor(fake);
  const key = fake.artworkKey(artworkSource(serverPlatformId(config), 'al-1_abc', 300));
  const sizes = [];
  const big = Buffer.alloc(400 * 1024, 1);
  const m = mockSubsonicFetch({
    getCoverArt: (url) => {
      sizes.push(url.searchParams.get('size'));
      assert.equal(url.searchParams.get('id'), 'al-1_abc');
      assert.ok(url.searchParams.get('t') || url.searchParams.get('p'), 'authenticated');
      return url.searchParams.get('size') === '300'
        ? { __image: big, __mime: 'image/jpeg' }
        : { __image: Buffer.from([0xff, 0xd8, 0xff]), __mime: 'image/jpeg' };
    },
  });
  try {
    assert.equal(await catalog.artwork(key), Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
    assert.deepEqual(sizes, ['300', '200'], 'smaller when the first answer is too large');
    await assert.rejects(() => catalog.artwork('art-000000000000'), /Unknown artwork/);
    // Another server, other keys.
    const other = fake.artworkKey(artworkSource('other-host', 'al-1_abc', 300));
    await assert.rejects(() => catalog.artwork(other), /Unknown artwork/);
  } finally {
    m.restore();
  }
});

test('media ids are parsed back, bounded', () => {
  assert.deepEqual(parseMediaId('album:al-1'), { kind: 'album', itemId: 'al-1' });
  assert.deepEqual(parseMediaId('track:a:b'), { kind: 'track', itemId: 'a:b' });
  assert.equal(parseMediaId('folder:x'), null);
  assert.equal(parseMediaId(`track:${'x'.repeat(600)}`), null);
  assert.equal(parseMediaId(undefined), null);
});
