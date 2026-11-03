import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { createLocalPathPicker, PathPickerError } from '../lib/local-path-picker.mjs';

const folder = resolve('fake-native-selection'); // no files/directories created
const dir = { isDirectory: () => true, isFile: () => false };
const file = { isDirectory: () => false, isFile: () => true };
const failed = code => error => error instanceof PathPickerError && error.code === code;
function fixture(options = {}) {
  const calls = [], stats = [];
  const picker = createLocalPathPicker({ platform: 'win32',
    getCapability: () => ({ kind: 'native', async pick(signal) { calls.push(signal); return folder; } }),
    async statImpl(path) { stats.push(path); return path === folder ? dir : file; }, ...options });
  return { picker, calls, stats };
}

test('only a native host capability can open a dialog; unknown purpose cannot invoke it', async () => {
  const f = fixture();
  await assert.rejects(f.picker('cloudApiKeyFile'), failed('invalid_input'));
  assert.equal(f.calls.length, 0);
  for (const capability of [undefined, { kind: 'browse', pick() { throw new Error('must not browse'); } }, { kind: 'native' }]) {
    const f = fixture({ getCapability: () => capability });
    await assert.rejects(f.picker('pythonPath'), failed('picker_unavailable'));
    assert.deepEqual(f.stats, []);
  }
});

test('model directory selection returns a path only, without reading model contents or saving settings', async () => {
  const f = fixture();
  assert.deepEqual(await f.picker('localModelDir'), { status: 'ok', cancelled: false, path: folder });
  assert.deepEqual(f.stats, [folder]);
  assert.equal(f.calls.length, 1);
});

test('Python folder recognizes fixed installation and venv executable names without executing them', async () => {
  for (const expected of ['python.exe', join('Scripts', 'python.exe')]) {
    const seen = [];
    const f = fixture({ statImpl: async path => {
      seen.push(path);
      if (path === folder) return dir;
      if (path === join(folder, expected)) return file;
      throw new Error('not found');
    } });
    assert.equal((await f.picker('pythonPath')).path, join(folder, expected));
    assert.ok(seen.length <= 3);
  }
  const f = fixture({ statImpl: async path => path === folder ? dir : Promise.reject(new Error('secret native detail')) });
  await assert.rejects(f.picker('pythonPath'), failed('python_not_found'));
});

test('non-Windows fixed candidates include bin/python3 and never search recursively', async () => {
  const f = fixture({ platform: 'linux' });
  assert.equal((await f.picker('pythonPath')).path, join(folder, 'bin', 'python3'));
  assert.deepEqual(f.stats, [folder, join(folder, 'bin', 'python3')]);
});

test('cancelled native selection or preaborted request leaves configuration untouched', async () => {
  const f = fixture({ getCapability: () => ({ kind: 'native', pick: async () => null }) });
  assert.deepEqual(await f.picker('pythonPath'), { status: 'ok', cancelled: true });
  assert.deepEqual(f.stats, []);
  const controller = new AbortController(); controller.abort();
  const g = fixture();
  assert.equal((await g.picker('localModelDir', { signal: controller.signal })).cancelled, true);
  assert.equal(g.calls.length, 0);
});

test('timeout/abort ignores late native success and retains the gate until the native call settles', async () => {
  let finish;
  const f = fixture({ getCapability: () => ({ kind: 'native', pick: () => new Promise(resolve => { finish = resolve; }) }) });
  const controller = new AbortController();
  const pending = f.picker('pythonPath', { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  assert.equal((await pending).cancelled, true);
  await assert.rejects(f.picker('localModelDir'), failed('picker_busy'));
  finish(folder); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.stats, []);
  f.picker.dispose();
  await assert.rejects(f.picker('localModelDir'), failed('picker_unavailable'));
});

test('plugin disposal aborts an outstanding dialog and discards late results', async () => {
  let signal, finish;
  const f = fixture({ getCapability: () => ({ kind: 'native', pick: s => { signal = s; return new Promise(resolve => { finish = resolve; }); } }) });
  const pending = f.picker('localModelDir'); await Promise.resolve();
  f.picker.dispose();
  assert.equal(signal.aborted, true);
  assert.equal((await pending).cancelled, true);
  finish(folder); await Promise.resolve();
  assert.deepEqual(f.stats, []);
});

test('already-chosen desktop directories resolve without a native service, opening a dialog or reading file contents', async () => {
  const f = fixture({ getCapability() { throw new Error('must not request a native service'); } });
  assert.equal((await f.picker.resolve('pythonPath', folder)).path, join(folder, 'python.exe'));
  assert.deepEqual(f.stats, [folder, join(folder, 'python.exe')]); assert.equal(f.calls.length, 0);
  assert.equal((await f.picker.resolve('localModelDir', folder)).path, folder);
  for (const selected of ['relative', '\\\\server\\share', folder + '\n', null])
    await assert.rejects(f.picker.resolve('localModelDir', selected), failed('picker_failed'));
  await assert.rejects(f.picker.resolve('cloudApiKeyFile', folder), failed('invalid_input'));
  const abort = new AbortController(); abort.abort(); const count = f.stats.length;
  assert.equal((await f.picker.resolve('pythonPath', folder, { signal: abort.signal })).cancelled, true);
  assert.equal(f.stats.length, count);
  f.picker.dispose(); await assert.rejects(f.picker.resolve('pythonPath', folder), failed('picker_unavailable'));
});

test('invalid selections and native exceptions return fixed codes, never raw details', async () => {
  for (const selected of ['relative', '\\\\server\\share', folder + '\n', 1, { path: folder }]) {
    const f = fixture({ getCapability: () => ({ kind: 'native', pick: async () => selected }) });
    await assert.rejects(f.picker('localModelDir'), failed('picker_failed'));
    assert.deepEqual(f.stats, []);
  }
  const f = fixture({ getCapability: () => ({ kind: 'native', pick: async () => { throw new Error('private data'); } }) });
  await assert.rejects(f.picker('localModelDir'), error => failed('picker_failed')(error) && !error.message.includes('private data'));
});
