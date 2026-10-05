// -----------------------------------------------------------------------------
// Dashboard widget contents: every content the builders produce is checked
// against the core's vocabulary and budget (validateWidgetContent returns []
// when Gladys would render it exactly as sent), in its nominal and empty
// states.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  WIDGET,
  JUKEBOX_ACTION,
  LIBRARY_ACTION,
  TTL,
  fit,
  describeTrack,
  describeServer,
  currentJukeboxTrack,
  messageContent,
  notConfiguredContent,
  unreachableContent,
  buildNowPlayingContent,
  buildJukeboxContent,
  buildLibraryContent,
} from '../src/widgets.js';
import { coverImageKey } from '../src/covers.js';

const IMAGE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const register = (coverArtId) => coverImageKey(coverArtId);
const streamsFeature = 'server:music-example-com:active-streams';

const entry = (overrides = {}) => ({
  id: 'mf-1',
  title: 'Karma Police',
  artist: 'Radiohead',
  album: 'OK Computer',
  coverArt: 'al-OK1',
  username: 'guilhem',
  playerName: 'Kitchen',
  ...overrides,
});

test('widget keys and action keys match the core grammar', () => {
  for (const key of [
    ...Object.values(WIDGET),
    ...Object.values(JUKEBOX_ACTION),
    LIBRARY_ACTION.SCAN,
  ]) {
    assert.match(key, /^[a-z0-9_]{2,32}$/);
  }
  const actions = Object.values(JUKEBOX_ACTION);
  assert.equal(new Set(actions).size, actions.length, 'action keys are unique');
  for (const ttl of Object.values(TTL)) {
    assert.ok(ttl >= 10 && ttl <= 3600, `ttl ${ttl} out of the 10-3600 range`);
  }
});

test('fit cuts a text to its bound with an ellipsis', () => {
  assert.equal(fit('  short  ', 10), 'short');
  assert.equal(fit('abcdefghij', 10), 'abcdefghij');
  assert.equal(fit('abcdefghijk', 10), 'abcdefghi…');
  assert.equal(fit(undefined, 10), '');
});

test('describeTrack joins artist and album, skipping what is missing', () => {
  assert.equal(describeTrack(entry()), 'Radiohead · OK Computer');
  assert.equal(describeTrack({ artist: 'Air' }), 'Air');
  assert.equal(describeTrack({ album: ' Moon Safari ' }), 'Moon Safari');
  assert.equal(describeTrack({}), '');
  assert.equal(describeTrack(null), '');
});

test('message contents are valid and never an error', () => {
  for (const content of [
    notConfiguredContent(),
    unreachableContent('fetch failed'),
    messageContent('x'.repeat(400)),
  ]) {
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(content.components.length, 1);
    assert.equal(content.components[0].variant, 'body');
  }
  const unreachable = unreachableContent('ECONNREFUSED');
  assert.match(unreachable.components[0].text.fr, /injoignable : ECONNREFUSED/);
  assert.equal(unreachable.ttl_seconds, TTL.NOW_PLAYING, 'retried soon');
});

test('now_playing: the live streams tile and one row per entry, playing first', () => {
  const content = buildNowPlayingContent({
    entries: [
      entry({ id: 'a', title: 'Sexy Boy', artist: 'Air', album: 'Moon Safari', state: 'paused' }),
      entry(),
      entry({
        id: 'c',
        title: 'No tags',
        artist: undefined,
        album: undefined,
        coverArt: undefined,
      }),
    ],
    streamsFeature,
    register,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 30);

  const [tile, list] = content.components;
  assert.equal(tile.type, 'value');
  assert.equal(tile.device_feature, streamsFeature, 'bound to the published feature');
  assert.equal(list.type, 'card-list');
  assert.equal(list.display, 'list');
  assert.equal(list.items.length, 3);

  // The paused session goes after the ones that play.
  assert.deepEqual(
    list.items.map((item) => item.title),
    ['Karma Police', 'No tags', 'Sexy Boy'],
  );
  const [playing, bare, paused] = list.items;
  assert.equal(playing.subtitle, 'Radiohead · OK Computer');
  assert.deepEqual(playing.badge, { text: 'Kitchen', color: 'success' });
  assert.match(playing.image, IMAGE_KEY);
  assert.equal(playing.image, coverImageKey('al-OK1'));
  assert.equal(paused.badge.color, 'neutral');
  // No cover, no artist, no album: the row still renders, without them.
  assert.equal(bare.image, undefined);
  assert.equal(bare.subtitle, undefined);
});

test('now_playing: a listener without a player, a badge within 16 characters', () => {
  const content = buildNowPlayingContent({
    entries: [entry({ playerName: undefined, username: 'a-very-long-user-name-indeed' })],
    streamsFeature,
    register,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const [item] = content.components[1].items;
  assert.equal(item.badge.text.length, 16);
  assert.equal(item.badge.text, 'a-very-long-use…');
});

test('now_playing: at most 8 rows, then an explicit empty state', () => {
  const many = Array.from({ length: 12 }, (_, i) => entry({ id: `s${i}`, title: `Song ${i}` }));
  const content = buildNowPlayingContent({ entries: many, streamsFeature, register });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[1].items.length, 8);

  const empty = buildNowPlayingContent({ entries: [], streamsFeature, register });
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.equal(empty.components.length, 2, 'the live tile stays');
  assert.deepEqual(empty.components[1], {
    type: 'text',
    variant: 'body',
    text: { en: 'Nothing is playing right now.', fr: 'Rien en écoute.' },
  });
});

const queue = (overrides = {}) => ({
  currentIndex: 1,
  playing: true,
  gain: 0.75,
  position: 12,
  entry: [
    { id: 'mf-1', title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', coverArt: 'al-OK1' },
    {
      id: 'mf-2',
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      coverArt: 'al-OK1',
    },
    { id: 'mf-3', title: 'Subterranean Homesick Alien', artist: 'Radiohead', album: 'OK Computer' },
  ],
  ...overrides,
});

test('currentJukeboxTrack tolerates a missing or out-of-range index', () => {
  assert.equal(currentJukeboxTrack(queue()).current.title, 'Paranoid Android');
  assert.equal(currentJukeboxTrack(queue({ currentIndex: undefined })).index, 0);
  assert.equal(currentJukeboxTrack(queue({ currentIndex: -1 })).index, 0);
  assert.equal(currentJukeboxTrack(queue({ currentIndex: 7 })).index, 0);
  // A single entry comes as an object, not an array (XML heritage).
  const single = currentJukeboxTrack({ currentIndex: 0, entry: { id: 'x', title: 'Solo' } });
  assert.equal(single.entries.length, 1);
  assert.equal(single.current.title, 'Solo');
  assert.deepEqual(currentJukeboxTrack({}), { entries: [], index: 0, current: null });
  assert.equal(currentJukeboxTrack(undefined).current, null);
});

test('jukebox: a full remote while playing, within the content budget', () => {
  const content = buildJukeboxContent({ enabled: true, playlist: queue(), register });
  assert.deepEqual(validateWidgetContent(content), [], 'nothing dropped by the core');
  assert.equal(content.ttl_seconds, 30);
  assert.equal(content.components.length, 8, 'the whole budget, nothing beyond');

  const [heading, caption, image, status, ...buttons] = content.components;
  assert.deepEqual(heading, { type: 'text', variant: 'heading', text: 'Paranoid Android' });
  assert.deepEqual(caption, { type: 'text', variant: 'caption', text: 'Radiohead · OK Computer' });
  assert.equal(image.type, 'image');
  assert.equal(image.key, coverImageKey('al-OK1'));
  assert.equal(image.fit, 'contain', 'a square cover is never cropped');

  assert.equal(status.type, 'status');
  assert.deepEqual(
    status.items.map((row) => [row.label.fr, row.value.fr ?? row.value, row.color]),
    [
      ['État', 'Lecture', 'success'],
      ['Volume', '75 %', undefined],
      ['File', '2 / 3', undefined],
    ],
  );

  assert.deepEqual(
    buttons.map((b) => [b.type, b.label.fr, b.icon, b.action.key]),
    [
      ['button', 'Pause', 'pause', 'toggle'],
      ['button', 'Précédent', 'skip-back', 'previous'],
      ['button', 'Suivant', 'skip-forward', 'next'],
      ['button', 'Aléatoire', 'shuffle', 'random'],
    ],
  );
  assert.ok(
    buttons.every((b) => b.style === undefined),
    'never the primary style: invisible in dark mode',
  );
  const keys = buttons.map((b) => b.action.key);
  assert.equal(new Set(keys).size, keys.length, 'action keys unique in the content');
});

test('jukebox: play button and stopped state while stopped, no volume when unknown', () => {
  const content = buildJukeboxContent({
    enabled: true,
    playlist: queue({ playing: false, gain: undefined, currentIndex: 2 }),
    register,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(status.items[0].value, { en: 'Stopped', fr: 'Arrêt' });
  assert.equal(status.items[0].color, 'neutral');
  assert.equal(status.items.length, 2, 'no volume row without a gain');
  assert.equal(status.items[1].value, '3 / 3');
  const [toggle] = content.components.filter((c) => c.type === 'button');
  assert.equal(toggle.icon, 'play');
  assert.equal(toggle.label.fr, 'Lecture');
  assert.equal(toggle.action.key, 'toggle');
  // The third track has no cover: no image component, the rest stays.
  assert.equal(
    content.components.some((c) => c.type === 'image'),
    false,
  );
});

test('jukebox: an empty queue offers shuffle only, a disabled jukebox a sentence', () => {
  const empty = buildJukeboxContent({
    enabled: true,
    playlist: { currentIndex: 0, playing: false, gain: 1 },
    register,
  });
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.deepEqual(empty.components[0], {
    type: 'text',
    variant: 'heading',
    text: { en: 'Empty queue', fr: 'File vide' },
  });
  const buttons = empty.components.filter((c) => c.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].action.key, 'random');

  const disabled = buildJukeboxContent({ enabled: false, register });
  assert.deepEqual(validateWidgetContent(disabled), []);
  assert.equal(disabled.components.length, 1);
  assert.equal(
    disabled.components[0].text.fr,
    "Activez le jukebox dans la configuration de l'intégration.",
  );
  assert.equal(disabled.ttl_seconds, TTL.MESSAGE);
});

test('jukebox: long titles are cut to the heading and caption bounds', () => {
  const content = buildJukeboxContent({
    enabled: true,
    playlist: queue({
      currentIndex: 0,
      entry: [
        {
          id: 'x',
          title: 'T'.repeat(60),
          artist: 'A'.repeat(50),
          album: 'B'.repeat(50),
          coverArt: 'al-1',
        },
      ],
    }),
    register,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].text.length, 40);
  assert.equal(content.components[1].text.length, 80);
  assert.equal(content.components[2].alt.length, 60);
});

test('describeServer: OpenSubsonic identity, else the API version', () => {
  assert.equal(
    describeServer({ version: '1.16.1', type: 'navidrome', serverVersion: '0.53.3 (13af8ed4)' }),
    'navidrome 0.53.3 (13af8ed4)',
  );
  assert.equal(describeServer({ version: '1.16.1', type: 'gonic' }), 'gonic');
  assert.equal(describeServer({ version: '1.15.0' }), 'Subsonic API 1.15.0');
  assert.equal(describeServer(null), 'Subsonic');
});

const features = {
  songs: 'server:music-example-com:song-count',
  artists: 'server:music-example-com:artist-count',
  albums: 'server:music-example-com:album-count',
};
const serverInfo = { version: '1.16.1', type: 'navidrome', serverVersion: '0.53.3' };

test('library: three live tiles, the server and scan rows, a scan button', () => {
  const content = buildLibraryContent({
    features,
    serverInfo,
    scanStatus: { scanning: false, count: 4242, lastScan: '2026-10-05T10:00:00Z' },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.ttl_seconds, 900);
  const tiles = content.components.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((t) => [t.label.fr, t.device_feature]),
    [
      ['Morceaux', features.songs],
      ['Artistes', features.artists],
      ['Albums', features.albums],
    ],
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((row) => [row.label.fr, row.value.fr ?? row.value]),
    [
      ['Serveur', 'navidrome 0.53.3'],
      ['Scan', 'Terminé · 4242 morceaux'],
    ],
  );
  assert.equal(status.items[1].value.en, 'Done · 4242 songs');
  const [button] = content.components.filter((c) => c.type === 'button');
  assert.equal(button.action.key, LIBRARY_ACTION.SCAN);
  assert.equal(button.icon, 'refresh-cw');
  assert.equal(button.label.fr, 'Scanner');
});

test('library: a running scan is followed every 10 s, a refused one is said', () => {
  const scanning = buildLibraryContent({
    features,
    serverInfo,
    scanStatus: { scanning: true, count: 120 },
  });
  assert.deepEqual(validateWidgetContent(scanning), []);
  assert.equal(scanning.ttl_seconds, 10);
  const row = scanning.components.find((c) => c.type === 'status').items[1];
  assert.deepEqual(row.value, { en: 'Running · 120', fr: 'En cours · 120' });
  assert.equal(row.color, 'info');

  const refused = buildLibraryContent({ features, serverInfo: null, scanStatus: null });
  assert.deepEqual(validateWidgetContent(refused), []);
  assert.equal(refused.ttl_seconds, 900);
  const [serverRow, scanRow] = refused.components.find((c) => c.type === 'status').items;
  assert.equal(serverRow.value, 'Subsonic');
  assert.deepEqual(scanRow.value, { en: 'Unavailable', fr: 'Indisponible' });

  // A server reporting no count: "done", without a number.
  const uncounted = buildLibraryContent({ features, serverInfo, scanStatus: { scanning: false } });
  assert.deepEqual(validateWidgetContent(uncounted), []);
  assert.deepEqual(uncounted.components.find((c) => c.type === 'status').items[1].value, {
    en: 'Done',
    fr: 'Terminé',
  });
});
