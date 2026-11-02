import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAuthStore, createDpapiCrypto, AuthStoreError } from '../lib/auth-store.mjs';

const SESSION = 'FAKE_SESSION_FOR_OFFLINE_TEST_ONLY';
const KEY = { domain: 'video-study', name: 'bilibili' };
function serviceFixture() {
  let record;
  const calls = [];
  return { calls, readRecord: async key => { calls.push(['read', key]); return record; },
    modifyRecord: async (key, updater) => { calls.push(['modify', key]); record = await updater(record); },
    deleteRecord: async key => { calls.push(['delete', key]); record = undefined; }, snapshot: () => record };
}
function fakeCrypto() {
  const values = new Map(); let serial = 0;
  return { supported: true, protect: async value => { const cipher = Buffer.from('opaque-' + ++serial).toString('base64'); values.set(cipher, value); return cipher; },
    unprotect: async cipher => { if (!values.has(cipher)) throw new Error('opaque failure'); return values.get(cipher); } };
}

test('host record contains ciphertext only, never SESSDATA plaintext', async () => {
  const service = serviceFixture(), crypto = fakeCrypto();
  const store = createAuthStore({ credentials: service, key: KEY, crypto });
  assert.deepEqual(await store.save({ source: 'managed', sessdata: SESSION }), { persistent: true });
  assert.equal(service.snapshot().payload.algorithm, 'dpapi-current-user');
  assert.ok(!JSON.stringify(service.snapshot()).includes(SESSION));
  const restarted = createAuthStore({ credentials: service, key: KEY, crypto });
  assert.deepEqual(await restarted.load(), { source: 'managed', sessdata: SESSION });
  assert.deepEqual(store.capabilities(), { encrypted: true, persistent: true });
});

test('non-Windows/no encryption uses memory only and invalidates old persisted account', async () => {
  const service = serviceFixture();
  const store = createAuthStore({ credentials: service, key: KEY, crypto: { supported: false } });
  assert.deepEqual(await store.save({ source: 'managed', sessdata: SESSION }), { persistent: false });
  assert.equal(service.snapshot().payload.memoryOnly, true);
  assert.ok(!JSON.stringify(service.snapshot()).includes(SESSION));
  assert.equal((await store.load()).sessdata, SESSION);
  const restarted = createAuthStore({ credentials: service, key: KEY, crypto: { supported: false } });
  await assert.rejects(restarted.load(), AuthStoreError);
});

test('missing credentials service never writes an ad-hoc plaintext file', async () => {
  const store = createAuthStore({ credentials: null, key: KEY, crypto: fakeCrypto() });
  assert.deepEqual(await store.save({ source: 'managed', sessdata: SESSION }), { persistent: false });
  assert.equal((await store.load()).sessdata, SESSION);
  assert.equal(store.capabilities().persistent, false);
});

test('encryption failure downgrades explicitly to memory, never plaintext at rest', async () => {
  const service = serviceFixture();
  const store = createAuthStore({ credentials: service, key: KEY,
    crypto: { supported: true, protect: async () => { throw new Error('DO NOT LEAK'); } } });
  assert.equal((await store.save({ source: 'managed', sessdata: SESSION })).persistent, false);
  assert.equal(store.capabilities().encrypted, false);
  assert.ok(!JSON.stringify(service.snapshot()).includes(SESSION));
});

test('logout persists anonymous selection and removes prior credential envelope', async () => {
  const service = serviceFixture(), crypto = fakeCrypto();
  const store = createAuthStore({ credentials: service, key: KEY, crypto });
  await store.save({ source: 'managed', sessdata: SESSION });
  await store.save({ source: 'anonymous' });
  assert.deepEqual(service.snapshot().payload, { version: 1, source: 'anonymous' });
  const restarted = createAuthStore({ credentials: service, key: KEY, crypto });
  assert.deepEqual(await restarted.load(), { source: 'anonymous' });
  assert.ok(service.calls.every(([, key]) => key === KEY));
});

test('rollback clear restores absence without choosing an account', async () => {
  const service = serviceFixture(), store = createAuthStore({ credentials: service, key: KEY, crypto: fakeCrypto() });
  await store.save({ source: 'managed', sessdata: SESSION });
  await store.clear();
  assert.equal(await store.load(), null);
  assert.ok(service.calls.some(([action]) => action === 'delete'));
});

test('unreadable/corrupt records fail closed without anonymous fallback', async () => {
  const service = serviceFixture();
  await service.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { version: 99, source: 'managed' } }));
  const store = createAuthStore({ credentials: service, key: KEY, crypto: fakeCrypto() });
  await assert.rejects(store.load(), AuthStoreError);
});

test('read/write errors are scrubbed and cannot claim successful persistent save', async () => {
  const service = { readRecord: async () => { throw Error(SESSION); }, modifyRecord: async () => { throw Error(SESSION); } };
  const store = createAuthStore({ credentials: service, key: KEY, crypto: fakeCrypto() });
  for (const operation of [() => store.load(), () => store.save({ source: 'managed', sessdata: SESSION })]) {
    await assert.rejects(operation, error => error instanceof AuthStoreError && !error.message.includes(SESSION));
  }
});

test('malformed session data is refused before encryption or write', async () => {
  const service = serviceFixture(), crypto = fakeCrypto();
  const store = createAuthStore({ credentials: service, key: KEY, crypto });
  for (const sessdata of ['', 'contains space', 'line\nbreak', 'abc; injected', '中文', 'x'.repeat(16001)])
    await assert.rejects(store.save({ source: 'managed', sessdata }), AuthStoreError);
  assert.equal(service.snapshot(), undefined);
});

test('DPAPI private worker is unavailable rather than plaintext on other platforms', async () => {
  const crypto = createDpapiCrypto({ platform: 'linux', spawnImpl: () => { throw Error('must not spawn'); } });
  assert.equal(crypto.supported, false);
  await assert.rejects(crypto.protect(SESSION), AuthStoreError);
});

test('DPAPI worker uses fixed argv and secret only in stdin; errors do not echo it', async () => {
  let argv, input = '';
  const spawnImpl = (command, args, options) => {
    assert.match(command, /powershell\.exe$/i); argv = args;
    assert.equal(options.shell, false);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => { child.stdout.write('{"ok":false}'); child.emit('close', 1); });
    return child;
  };
  const crypto = createDpapiCrypto({ platform: 'win32', spawnImpl });
  await assert.rejects(crypto.protect(SESSION), error => !error.message.includes(SESSION));
  assert.ok(!JSON.stringify(argv).includes(SESSION));
  assert.equal(JSON.parse(input).value, SESSION);
});

test('actual Windows CurrentUser DPAPI round-trip with fake session only', { skip: process.platform !== 'win32' }, async () => {
  const crypto = createDpapiCrypto();
  const protectedValue = await crypto.protect(SESSION);
  assert.ok(!protectedValue.includes(SESSION));
  assert.match(protectedValue, /^[A-Za-z0-9+/=]+$/);
  assert.equal(await crypto.unprotect(protectedValue), SESSION);
});
