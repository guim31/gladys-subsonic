// -----------------------------------------------------------------------------
// Widget covers: the image keys, the registry behind them, and the bytes
// served to the core through onWidgetGetImage.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_SIZE,
  MAX_WIDGET_IMAGE_BYTES,
  coverImageKey,
  createCoverRegistry,
  splitDataImage,
  widgetCoverArt,
  resolveWidgetImage,
} from '../src/covers.js';
import { normalizeConfig } from '../src/config.js';
import { mockSubsonicFetch } from './helpers/fakeGladys.js';

const IMAGE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const config = normalizeConfig({
  server_url: 'https://music.example.com',
  username: 'admin',
  password: 'sesame',
});

test('image keys match the widget contract, whatever the cover id looks like', () => {
  for (const id of ['al-3f2a9c', 'mf-ABC_123', '42', 'Al/Bum?Weird', '', 'x'.repeat(200)]) {
    assert.match(coverImageKey(id), IMAGE_KEY);
  }
  assert.match(coverImageKey('al-3f2a9c'), /^cover-al3f2a9c-[0-9a-f]{8}-300$/);
  assert.match(coverImageKey('al-3f2a9c', 160), /^cover-al3f2a9c-[0-9a-f]{8}-160$/);
  assert.equal(coverImageKey('al-3f2a9c'), coverImageKey('al-3f2a9c'), 'stable');
  // A new cover gives a new key: the core caches an image one hour by key.
  assert.notEqual(coverImageKey('al-1'), coverImageKey('al-2'));
  // Two ids that reduce to the same letters, or share their first 40, must
  // not share a key either: the core would serve the wrong cover for an hour.
  assert.notEqual(coverImageKey('al-1'), coverImageKey('al1'));
  assert.notEqual(coverImageKey('AL-1'), coverImageKey('al-1'));
  assert.notEqual(coverImageKey(`${'a'.repeat(45)}1`), coverImageKey(`${'a'.repeat(45)}2`));
  assert.ok(coverImageKey('x'.repeat(200)).length <= 64);
});

test('the registry remembers the id behind a key, bounded to the latest ones', () => {
  const registry = createCoverRegistry();
  const key = registry.register('al-OK1');
  assert.equal(key, coverImageKey('al-OK1'));
  assert.equal(registry.lookup(key), 'al-OK1');
  assert.equal(registry.lookup('cover-unknown-300'), undefined);

  for (let i = 0; i < 100; i += 1) {
    registry.register(`al-${i}`);
  }
  assert.equal(registry.size(), 64);
  assert.equal(registry.lookup(coverImageKey('al-0')), undefined, 'the oldest is forgotten');
  assert.equal(registry.lookup(coverImageKey('al-99')), 'al-99');
  // Re-registering a cover keeps it alive.
  registry.register('al-40');
  for (let i = 100; i < 160; i += 1) {
    registry.register(`al-${i}`);
  }
  assert.equal(registry.lookup(coverImageKey('al-40')), 'al-40');
});

test('splitDataImage separates the mime type from the raw base64', () => {
  assert.deepEqual(splitDataImage('image/jpeg;base64,QUJD'), {
    mime: 'image/jpeg',
    base64: 'QUJD',
  });
  assert.deepEqual(splitDataImage('QUJD'), { mime: '', base64: 'QUJD' });
});

test('the cover is served as raw base64 at the widget size', async () => {
  const mock = mockSubsonicFetch({
    getCoverArt: { __image: 'fake-jpeg-bytes', __mime: 'image/jpeg' },
  });
  let base64;
  try {
    base64 = await widgetCoverArt(config, 'al-OK1');
  } finally {
    mock.restore();
  }
  assert.equal(Buffer.from(base64, 'base64').toString(), 'fake-jpeg-bytes');
  assert.doesNotMatch(base64, /;base64,/, 'no data URI prefix for a widget image');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url.searchParams.get('id'), 'al-OK1');
  assert.equal(mock.calls[0].url.searchParams.get('size'), String(COVER_SIZE));
});

test('a cover too big at 300 px is asked again smaller, then refused', async () => {
  const big = Buffer.alloc(MAX_WIDGET_IMAGE_BYTES + 1, 1);
  const mock = mockSubsonicFetch({
    getCoverArt: (url) => ({
      __image: url.searchParams.get('size') === '160' ? 'small' : big,
      __mime: 'image/jpeg',
    }),
  });
  try {
    const base64 = await widgetCoverArt(config, 'al-big');
    assert.equal(Buffer.from(base64, 'base64').toString(), 'small');
    assert.deepEqual(
      mock.calls.map((c) => c.url.searchParams.get('size')),
      ['300', '160'],
    );
  } finally {
    mock.restore();
  }

  const stubborn = mockSubsonicFetch({ getCoverArt: { __image: big, __mime: 'image/jpeg' } });
  try {
    await assert.rejects(() => widgetCoverArt(config, 'al-big'), /unusable.*stays above/);
  } finally {
    stubborn.restore();
  }
});

test('a cover of a type the core refuses is not served', async () => {
  // An SVG placeholder (some servers answer one for a missing cover) at
  // 300 px, a JPEG at 160 px: the usable one wins.
  const mixed = mockSubsonicFetch({
    getCoverArt: (url) =>
      url.searchParams.get('size') === '160'
        ? { __image: 'small-jpeg', __mime: 'image/jpeg' }
        : { __image: '<svg/>', __mime: 'image/svg+xml' },
  });
  try {
    const base64 = await widgetCoverArt(config, 'al-svg');
    assert.equal(Buffer.from(base64, 'base64').toString(), 'small-jpeg');
  } finally {
    mixed.restore();
  }
  const gif = mockSubsonicFetch({ getCoverArt: { __image: 'GIF89a', __mime: 'image/gif' } });
  try {
    await assert.rejects(
      () => widgetCoverArt(config, 'al-gif'),
      /image\/gif is not a JPEG, PNG or WebP/,
    );
    assert.equal(gif.calls.length, 2, 'every size was tried');
  } finally {
    gif.restore();
  }
  // Mime types come in any case, with parameters stripped by getCoverArt.
  const upper = mockSubsonicFetch({ getCoverArt: { __image: 'png', __mime: 'image/PNG' } });
  try {
    assert.equal(Buffer.from(await widgetCoverArt(config, 'al-png'), 'base64').toString(), 'png');
  } finally {
    upper.restore();
  }
});

test('resolveWidgetImage serves a registered key and refuses the rest', async () => {
  const registry = createCoverRegistry();
  const key = registry.register('al-OK1');
  const mock = mockSubsonicFetch({
    getCoverArt: { __image: 'fake-jpeg-bytes', __mime: 'image/jpeg' },
  });
  try {
    const base64 = await resolveWidgetImage(registry, config, key);
    assert.equal(Buffer.from(base64, 'base64').toString(), 'fake-jpeg-bytes');
    await assert.rejects(
      () => resolveWidgetImage(registry, config, 'cover-nope-00000000-300'),
      /Unknown/,
    );
    await assert.rejects(() => resolveWidgetImage(registry, config, 'Not A Key'), /Invalid/);
    assert.equal(mock.calls.length, 1, 'an unknown key costs no request');
  } finally {
    mock.restore();
  }
});
