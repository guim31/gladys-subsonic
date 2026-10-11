// -----------------------------------------------------------------------------
// Every text shown to the user exists in the four languages of the Gladys
// interface (en, fr, de, es), is not empty, fits where it is shown, and the
// German one says "du" (the register chosen for guim31's integrations).
//
// The manifest is walked whole: any object carrying a language key is a
// multi-language text. The code texts all live in src/i18n.js, and a scan of
// the sources makes sure none is written anywhere else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { LANGUAGES, TEXT, MESSAGES, thrown } from '../src/i18n.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));

const LANGUAGE_KEYS = new Set(['en', 'fr', 'de', 'es', 'it', 'nl', 'pt', 'pl']);
// The formal German address, capitalized ("Sie", "Ihr"...): never, German
// says "du". Lowercase "sie"/"ihr" (they, her) stay allowed.
const FORMAL_GERMAN = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;

/**
 * Check one multi-language object.
 * @param {object} text
 * @param {string} path where it was found, for the messages
 * @param {number} max the bound, in characters per language
 */
function checkText(text, path, max) {
  assert.deepEqual(Object.keys(text).sort(), [...LANGUAGES].sort(), `${path}: en, fr, de, es`);
  for (const lang of LANGUAGES) {
    const value = text[lang];
    assert.equal(typeof value, 'string', `${path}.${lang} is a string`);
    assert.ok(value.trim().length > 0, `${path}.${lang} is empty`);
    assert.ok(value.length <= max, `${path}.${lang} is ${value.length} characters, ${max} max`);
  }
  assert.doesNotMatch(text.de, FORMAL_GERMAN, `${path}.de must say "du"`);
}

/** The bound of a manifest text, from where it sits. */
function manifestBound(path) {
  if (path === 'description') return 100;
  if (/^widgets\[\d+\]\.label$/.test(path)) return 30;
  if (/^widgets\[\d+\]\.description$/.test(path)) return 100;
  if (/\.label$/.test(path)) return 60;
  return 400;
}

/** Every multi-language object of a JSON tree, with its path. */
function* multiLanguageObjects(node, path = '') {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      yield* multiLanguageObjects(item, `${path}[${index}]`);
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (Object.keys(node).some((key) => LANGUAGE_KEYS.has(key))) {
    yield [path, node];
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* multiLanguageObjects(value, path ? `${path}.${key}` : key);
  }
}

test('every multi-language text of the manifest has en, fr, de and es', () => {
  const found = [...multiLanguageObjects(manifest)];
  // Guard against a walk that silently finds nothing.
  assert.ok(found.length >= 31, `only ${found.length} texts found in the manifest`);
  for (const [path, text] of found) {
    checkText(text, path, manifestBound(path));
  }
});

// The fixed texts shown in a widget tile, a status row or a button: the SDK
// bounds them to 24 characters (status values to 40), short is better.
const WIDGET_LABELS = [
  'streams',
  'state',
  'playing',
  'stopped',
  'volume',
  'queue',
  'play',
  'pause',
  'previous',
  'next',
  'random',
  'songs',
  'artists',
  'albums',
  'server',
  'scan',
  'scanUnavailable',
  'scanDone',
  'scanButton',
  'emptyQueue',
];
// Thrown from a widget button: the four languages joined make a toast,
// 200 characters at most.
const WIDGET_THROWN = ['jukeboxNotEnabled', 'serverNotConfigured', 'scanRefusedShort'];

test('every fixed text of the code has en, fr, de and es', () => {
  assert.ok(Object.keys(TEXT).length >= 30, 'the TEXT table is read whole');
  for (const [key, text] of Object.entries(TEXT)) {
    checkText(text, `TEXT.${key}`, WIDGET_LABELS.includes(key) ? 24 : 300);
  }
  for (const key of WIDGET_THROWN) {
    assert.ok(thrown(TEXT[key]).length <= 200, `TEXT.${key} joined is a toast`);
  }
  assert.ok(thrown(TEXT.scanNotStarted, 'x'.repeat(40)).length <= 200);
});

// Every message builder, called with values as long as real ones.
const SAMPLES = {
  unreachable: ['connect ECONNREFUSED 192.168.1.10:4533'],
  player: ['Feishin on the living room laptop'],
  scanRunning: [' · 123456'],
  scanDoneCount: [123456],
  scanInProgress: [123456],
  connected: ['navidrome 0.53.3 (abc1234)', '1.16.1'],
  connectedUnnamed: ['1.16.1'],
  serverUnreachable: ['connect ECONNREFUSED 192.168.1.10:4533'],
  publishFailed: ['Request failed with status code 422'],
  playlistNotFound: ['Morning', 'Chill, Party, Workout'],
  playlistEmpty: ['Morning'],
  playingPlaylist: ['Morning', 120],
  playingRandom: [20],
};
// Messages also resolved as a widget toast (200 characters at most).
const WIDGET_TOASTS = ['scanInProgress', 'playingRandom'];

test('every message builder of the code has en, fr, de and es', () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), Object.keys(SAMPLES).sort(), 'a sample each');
  for (const [key, build] of Object.entries(MESSAGES)) {
    const max = WIDGET_TOASTS.includes(key) ? 200 : 300;
    checkText(build(...SAMPLES[key]), `MESSAGES.${key}`, max);
  }
  // The optional parts, left out.
  checkText(MESSAGES.scanInProgress(undefined), 'MESSAGES.scanInProgress()', 200);
  checkText(MESSAGES.playlistNotFound('Morning', ''), 'MESSAGES.playlistNotFound(none)', 300);
});

test('no multi-language text is written outside src/i18n.js', async () => {
  const sources = ['../index.js'];
  for (const dir of ['../src/', '../src/devices/']) {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'i18n.js') {
        sources.push(`${dir}${entry.name}`);
      }
    }
  }
  assert.ok(sources.length >= 8, 'every source file is scanned');
  for (const path of sources) {
    const source = await read(path);
    assert.doesNotMatch(
      source,
      /\b(en|fr|de|es)\s*:\s*['"`]/,
      `${path} writes a text by hand: move it to src/i18n.js`,
    );
  }
});

test('the checks catch a missing language and the formal German address', () => {
  assert.throws(() => checkText({ en: 'Play', fr: 'Lecture', de: 'Abspielen' }, 'x', 24));
  assert.throws(() => checkText({ en: 'a', fr: 'a', de: 'a', es: '' }, 'x', 24));
  assert.throws(() => checkText({ en: 'a', fr: 'a', de: 'a'.repeat(25), es: 'a' }, 'x', 24));
  assert.throws(() =>
    checkText({ en: 'a', fr: 'a', de: 'Geben Sie Ihr Passwort ein', es: 'a' }, 'x', 60),
  );
  checkText({ en: 'a', fr: 'a', de: 'Gib dein Passwort ein', es: 'a' }, 'x', 60);
});
