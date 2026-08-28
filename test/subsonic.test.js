import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthParams,
  buildUrl,
  request,
  redactAuth,
  asArray,
  ping,
  jukeboxControl,
  SubsonicError,
  API_VERSION,
  CLIENT_NAME,
} from '../src/subsonic.js';
import { normalizeConfig } from '../src/config.js';
import { mockSubsonicFetch } from './helpers/fakeGladys.js';

const config = normalizeConfig({
  server_url: 'https://music.example.com',
  username: 'admin',
  password: 'sesame',
});

test('token auth matches the reference example of the API documentation', () => {
  // From https://www.subsonic.org/pages/api.jsp: password "sesame" and salt
  // "c19b2d" must give the token 26719a1196d2a940705a59634eb18eab.
  const params = buildAuthParams(config, 'c19b2d');
  assert.equal(params.u, 'admin');
  assert.equal(params.s, 'c19b2d');
  assert.equal(params.t, '26719a1196d2a940705a59634eb18eab');
  assert.equal(params.v, API_VERSION);
  assert.equal(params.c, CLIENT_NAME);
  assert.equal(params.f, 'json');
  assert.equal(params.p, undefined, 'the password itself must never be sent');
});

test('token auth uses a fresh random salt on every call', () => {
  const first = buildAuthParams(config);
  const second = buildAuthParams(config);
  assert.notEqual(first.s, second.s);
  assert.notEqual(first.t, second.t);
});

test('legacy auth sends the hex-obfuscated password', () => {
  const params = buildAuthParams({ ...config, auth_method: 'legacy' });
  assert.equal(params.p, `enc:${Buffer.from('sesame', 'utf8').toString('hex')}`);
  assert.equal(params.t, undefined);
  assert.equal(params.s, undefined);
});

test('buildUrl targets /rest/<endpoint>.view and repeats array parameters', () => {
  const url = new URL(buildUrl(config, 'jukeboxControl', { action: 'add', id: ['a', 'b'] }));
  assert.equal(url.origin, 'https://music.example.com');
  assert.equal(url.pathname, '/rest/jukeboxControl.view');
  assert.equal(url.searchParams.get('action'), 'add');
  assert.deepEqual(url.searchParams.getAll('id'), ['a', 'b']);
});

test('request unwraps the envelope and reports API failures as SubsonicError', async () => {
  const mock = mockSubsonicFetch({
    ping: {},
    getLicense: { status: 'failed', error: { code: 40, message: 'Wrong username or password.' } },
  });
  try {
    const envelope = await request(config, 'ping');
    assert.equal(envelope.status, 'ok');
    await assert.rejects(
      () => request(config, 'getLicense'),
      (err) =>
        err instanceof SubsonicError && err.code === 40 && /Wrong username/.test(err.message),
    );
  } finally {
    mock.restore();
  }
});

test('ping returns the API version and the OpenSubsonic identity when present', async () => {
  const mock = mockSubsonicFetch({
    ping: { type: 'navidrome', serverVersion: '0.52.5' },
  });
  try {
    const info = await ping(config);
    assert.equal(info.version, '1.16.1');
    assert.equal(info.type, 'navidrome');
    assert.equal(info.serverVersion, '0.52.5');
  } finally {
    mock.restore();
  }
});

test('jukeboxControl returns the playlist for get and the status otherwise', async () => {
  const mock = mockSubsonicFetch({
    jukeboxControl: (url) =>
      url.searchParams.get('action') === 'get'
        ? { jukeboxPlaylist: { currentIndex: 2, playing: true, gain: 0.75, entry: [{ id: '1' }] } }
        : { jukeboxStatus: { currentIndex: 2, playing: false, gain: 0.5 } },
  });
  try {
    const playlist = await jukeboxControl(config, 'get');
    assert.equal(playlist.currentIndex, 2);
    assert.equal(playlist.entry.length, 1);
    const status = await jukeboxControl(config, 'stop');
    assert.equal(status.playing, false);
    assert.equal(status.gain, 0.5);
  } finally {
    mock.restore();
  }
});

test('redactAuth blanks the token, salt and legacy password of an embedded URL', () => {
  const text =
    'Failed to parse URL from host/rest/ping.view?u=admin&t=26719a11&s=c19b2d&p=enc:abc&v=1.16.1';
  const redacted = redactAuth(text);
  assert.ok(!redacted.includes('26719a11'), 'token must be redacted');
  assert.ok(!redacted.includes('c19b2d'), 'salt must be redacted');
  assert.ok(!redacted.includes('enc:abc'), 'legacy password must be redacted');
  assert.ok(redacted.includes('u=admin'), 'non-secret params stay readable');
});

test('a network failure never leaks the auth parameters in the error message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new TypeError(`Failed to parse URL from ${url}`);
  };
  try {
    await assert.rejects(
      () => request(config, 'ping'),
      (err) =>
        /ping request failed/.test(err.message) &&
        !/[?&]t=(?!\*\*\*)/.test(err.message) &&
        !/[?&]s=(?!\*\*\*)/.test(err.message),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('asArray normalizes the single-child / array / absent API shapes', () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ id: 1 }), [{ id: 1 }]);
  assert.deepEqual(asArray([{ id: 1 }, { id: 2 }]), [{ id: 1 }, { id: 2 }]);
});
