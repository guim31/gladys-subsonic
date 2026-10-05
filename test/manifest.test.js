// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { WIDGET, JUKEBOX_ACTION, LIBRARY_ACTION } from '../src/widgets.js';
import { server } from '../src/devices/server.js';
import { jukebox } from '../src/devices/jukebox.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));
const indexSource = await read('../index.js');
const packageJson = JSON.parse(await read('../package.json'));

test('every manifest action has a registered handler', () => {
  const handled = new Set(DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every config key the code relies on is declared in the manifest', () => {
  const declared = new Set(
    manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key),
  );
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(declared.has(key), `DEFAULT_CONFIG.${key} is not declared in the config_schema`);
  }
});

test('the password field is a secret and never has a default', () => {
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(password.type, 'secret');
  assert.equal(password.default, undefined);
});

test('the manifest version and the docker image tag stay in lockstep', () => {
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image "${manifest.docker_image}" must be tagged with the version ${manifest.version}`,
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the form carries at least one onboarding section');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

// --- Dashboard widgets --------------------------------------------------------

test('the declared widgets are exactly the ones the code serves', () => {
  assert.deepEqual(manifest.widgets.map((w) => w.key).sort(), Object.values(WIDGET).sort());
  for (const name of Object.keys(WIDGET)) {
    assert.ok(indexSource.includes(`onWidgetGet(WIDGET.${name}`), `no onWidgetGet for ${name}`);
  }
  // The widgets with buttons have an action handler, and the handler covers
  // every action key its content can carry.
  assert.ok(indexSource.includes('onWidgetAction(WIDGET.JUKEBOX'));
  assert.ok(indexSource.includes('onWidgetAction(WIDGET.LIBRARY'));
  assert.ok(indexSource.includes('onWidgetGetImage('), 'covers are served by key');
  assert.equal(typeof jukebox.widgetAction, 'function');
  assert.equal(typeof server.widgetAction, 'function');
  for (const key of [...Object.values(JUKEBOX_ACTION), ...Object.values(LIBRARY_ACTION)]) {
    assert.match(key, /^[a-z0-9_]{2,32}$/);
  }
});

test('widgets need Gladys 5.1 and the 0.14 SDK', () => {
  assert.match(manifest.gladys_version, />=\s*5\.1\.0/, 'widgets need the 5.1 core');
  assert.match(packageJson.dependencies['@gladysassistant/integration-sdk'], /\^0\.14\./);
});

test('widget declarations respect the store constraints', () => {
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    for (const lang of ['en', 'fr']) {
      const label = widget.label[lang];
      assert.ok(label.length >= 3 && label.length <= 30, `${widget.key} label.${lang} "${label}"`);
      const description = widget.description?.[lang] ?? '';
      assert.ok(description.length <= 100, `${widget.key} description.${lang} is too long`);
    }
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/, 'a Feather icon name');
    if (widget.action_timeout_seconds !== undefined) {
      assert.ok(
        widget.action_timeout_seconds >= 5 && widget.action_timeout_seconds <= 120,
        `${widget.key} action_timeout_seconds out of range`,
      );
    }
    for (const field of widget.settings ?? []) {
      if (field.type === 'number') {
        for (const bound of ['min', 'max', 'default']) {
          if (field[bound] !== undefined) {
            assert.ok(Number.isInteger(field[bound]), `${field.key}.${bound} must be an integer`);
          }
        }
      }
    }
  }
  // The widgets with buttons declare how long a tap may take.
  for (const key of [WIDGET.JUKEBOX, WIDGET.LIBRARY]) {
    const widget = manifest.widgets.find((w) => w.key === key);
    assert.equal(typeof widget.action_timeout_seconds, 'number', `${key} has buttons`);
  }
});

test('the user documentation describes the widgets in both languages', async () => {
  for (const lang of ['en', 'fr']) {
    const doc = await read(`../docs/${lang}.md`);
    assert.ok(doc.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(doc, /widget/i, `docs/${lang}.md must document the widgets`);
  }
});
