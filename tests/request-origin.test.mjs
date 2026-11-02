import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../lib/request-origin.mjs';

const synthetic = 'http://dsh.internal/api/video-study/asr/save';
const request = (url, headers = {}) => new Request(url, { method: 'POST', headers });

test('real browser origin is compared with original Host for native synthetic URLs', () => {
  for (const [host, origin] of [
    ['127.0.0.1:1180', 'http://127.0.0.1:1180'],
    ['localhost:1180', 'http://localhost:1180'],
    ['[::1]:1180', 'http://[::1]:1180'],
    ['settings.example:443', 'https://settings.example'],
    ['settings.example:80', 'http://settings.example'],
  ]) assert.equal(isSameOriginRequest(request(synthetic, { host, origin })), true);
});

test('ordinary Fetch requests retain exact request URL origin validation', () => {
  assert.equal(isSameOriginRequest(request('http://localhost:1180/api/test', { origin: 'http://localhost:1180' })), true);
  assert.equal(isSameOriginRequest(request('http://localhost:1180/api/test', { host: 'evil.example', origin: 'http://evil.example' })), false);
});

test('synthetic URL never grants arbitrary Origin or trusts forwarded headers', () => {
  for (const headers of [
    { host: '127.0.0.1:1180', origin: 'http://evil.example' },
    { host: '127.0.0.1:1180', origin: 'http://127.0.0.1:1181' },
    { host: 'localhost:1180', origin: 'http://127.0.0.1:1180' },
    { origin: 'http://dsh.internal' },
    { host: '127.0.0.1:1180', origin: 'http://evil.example', 'x-forwarded-host': 'evil.example' },
    { host: '127.0.0.1:1180', origin: 'http://evil.example', forwarded: 'host=evil.example;proto=http' },
  ]) assert.equal(isSameOriginRequest(request(synthetic, headers)), false);
});

test('opaque, credentialed, path, query, fragment and non-http Origins are rejected', () => {
  for (const origin of ['null', 'file:///', 'https://user@localhost:1180',
    'http://localhost:1180/path', 'http://localhost:1180/?', 'http://localhost:1180/#', 'data:text/plain,test'])
    assert.equal(isSameOriginRequest(request(synthetic, { host: 'localhost:1180', origin })), false);
});

test('malformed Host authorities cannot reinterpret the expected origin', () => {
  for (const host of ['user@localhost:1180', 'localhost:1180/path', 'localhost:1180?', 'localhost:1180#',
    'localhost:1180\\evil', 'localhost:1180 evil', 'localhost:999999', 'localhost:1180,evil.example'])
    assert.equal(isSameOriginRequest(request(synthetic, { host, origin: 'http://localhost:1180' })), false);
});

test('cross-site is rejected even with no Origin; originless owner clients retain compatibility', () => {
  assert.equal(isSameOriginRequest(request(synthetic)), true);
  assert.equal(isSameOriginRequest(request(synthetic, { 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isSameOriginRequest(request(synthetic, { host: 'localhost:1180', origin: 'http://localhost:1180', 'sec-fetch-site': 'cross-site' })), false);
});
