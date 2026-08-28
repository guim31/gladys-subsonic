import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigured, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig strips the trailing slash and spaces from the server URL', () => {
  assert.equal(
    normalizeConfig({ server_url: ' https://music.example.com/ ' }).server_url,
    'https://music.example.com',
  );
  assert.equal(
    normalizeConfig({ server_url: 'http://192.168.1.10:4533//' }).server_url,
    'http://192.168.1.10:4533',
  );
});

test('normalizeConfig adds the missing scheme to a bare host:port', () => {
  assert.equal(
    normalizeConfig({ server_url: '192.168.100.150:4533' }).server_url,
    'http://192.168.100.150:4533',
  );
  assert.equal(
    normalizeConfig({ server_url: 'music.example.com' }).server_url,
    'http://music.example.com',
  );
  // An explicit scheme is kept untouched.
  assert.equal(
    normalizeConfig({ server_url: 'https://music.example.com' }).server_url,
    'https://music.example.com',
  );
  assert.equal(normalizeConfig({ server_url: '' }).server_url, '');
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '120' });
  assert.equal(config.poll_frequency, 120);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig only accepts the two known auth methods', () => {
  assert.equal(normalizeConfig({ auth_method: 'legacy' }).auth_method, 'legacy');
  assert.equal(normalizeConfig({ auth_method: 'token' }).auth_method, 'token');
  assert.equal(normalizeConfig({ auth_method: 'whatever' }).auth_method, 'token');
});

test('jukebox_enabled accepts the boolean and its form-string variant', () => {
  assert.equal(normalizeConfig().jukebox_enabled, false);
  assert.equal(normalizeConfig({ jukebox_enabled: true }).jukebox_enabled, true);
  assert.equal(normalizeConfig({ jukebox_enabled: 'true' }).jukebox_enabled, true);
  assert.equal(normalizeConfig({ jukebox_enabled: false }).jukebox_enabled, false);
});

test('isConfigured requires the URL, the username and the password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ server_url: 'https://m.example.com' })), false);
  assert.equal(
    isConfigured(
      normalizeConfig({ server_url: 'https://m.example.com', username: 'u', password: 'p' }),
    ),
    true,
  );
});
