import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../lib/runtime.mjs';

const home = join(tmpdir(), 'document-test-home');
const out = join(home, 'Documents', 'DSH视频学习');
function fixture(config = {}, response) {
  const calls = [];
  const spawnImpl = (command, argv, options) => {
    const child = new EventEmitter(); child.pid = 99;
    child.stdout = new PassThrough(); child.stdin = new PassThrough();
    let stdin = ''; child.stdin.on('data', data => { stdin += data; });
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    const record = { command, argv, options }; calls.push(record);
    child.stdin.once('finish', () => queueMicrotask(() => {
      if (argv.includes('-c')) {
        child.stdout.write(JSON.stringify({ executable: resolve('fake-python.exe'), version: [3, 13] }));
      } else {
        record.request = JSON.parse(stdin);
        const value = response ? response(record.request) : { status: 'ok', document_file: join(record.request.directory, 'safe.' + record.request.format), formula_count: 3, warnings: [] };
        child.stdout.write(JSON.stringify(value));
      }
      child.emit('close', 0);
    }));
    return child;
  };
  const runtime = createRuntime(config, { spawnImpl, root: resolve('.'), homedirImpl: () => home,
    accessImpl: async () => { throw Error('not installed'); }, terminateImpl: async child => child.kill() });
  return { runtime, calls, requests: () => calls.filter(call => call.request).map(call => call.request) };
}
const args = { title: '公式测试', markdown: '## 正文\n\n$\\alpha/2$' };

test('export uses only private stdin and saved document settings, never cloud or login fields', async () => {
  const config = {};
  for (const key of ['mode', 'cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudUploadConsent', 'biliCookieFile', 'outputDir'])
    Object.defineProperty(config, key, { get() { throw Error('must not read ' + key); } });
  const f = fixture(config), result = await f.runtime.exportDocument(args);
  assert.equal(result.status, 'ok'); assert.equal(result.format, 'docx'); assert.equal(result.formula_count, 3);
  assert.deepEqual(f.requests(), [{ ...args, directory: out, format: 'docx' }]);
  assert.match(f.calls.at(-1).argv.at(-1), /document_export\.py$/);
  assert.equal(JSON.stringify(f.calls.map(call => call.argv)).includes(args.title), false);
});

test('saved live format and directory affect only the next export', async () => {
  const format = { value: 'md', get() { return this.value; } }, directory = { value: join(home, 'first'), get() { return this.value; } };
  const f = fixture({ documentFormat: format, documentOutputDir: directory });
  assert.equal((await f.runtime.exportDocument(args)).format, 'md');
  format.value = 'txt'; directory.value = join(home, 'second');
  assert.equal((await f.runtime.exportDocument(args)).format, 'txt');
  assert.deepEqual(f.requests().map(value => [value.format, value.directory]), [['md', join(home, 'first')], ['txt', join(home, 'second')]]);
});

test('tools cannot override directory/format, run installs or supply arbitrary paths', async () => {
  for (const patch of [{ directory: out }, { format: 'txt' }, { cloudApiKey: 'fake' }, { file: 'some-file' }, { title: '' }, { markdown: '' }]) {
    const f = fixture();
    assert.equal((await f.runtime.exportDocument({ ...args, ...patch })).status, 'invalid_input');
    assert.equal(f.calls.length, 0);
  }
});

test('invalid saved paths/formats and oversized content fail before launching Python', async () => {
  for (const config of [{ documentFormat: 'pdf' }, { documentOutputDir: 'relative' }, { documentOutputDir: '\\\\server\\share' }, { documentOutputDir: join(home, 'x') + '/../escape' }]) {
    const f = fixture(config);
    assert.equal((await f.runtime.exportDocument(args)).status, 'invalid_config'); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.runtime.exportDocument({ ...args, markdown: '中'.repeat(800000) })).status, 'invalid_input');
  assert.equal(f.calls.length, 0);
});

test('export snapshots settings before async discovery and supports cancellation', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await f.runtime.exportDocument(args, { signal: controller.signal })).status, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('returned path is bounded to the selected directory and extension', async () => {
  for (const document_file of [join(home, 'elsewhere.docx'), join(out, 'wrong.txt'), 'relative.docx']) {
    const f = fixture({}, () => ({ status: 'ok', document_file }));
    assert.equal((await f.runtime.exportDocument(args)).status, 'document_export_failed');
  }
});

test('dependency/provider errors are static, not raw runner diagnostics', async () => {
  const f = fixture({}, () => ({ status: 'error', code: 'dependency_missing', message: 'SENSITIVE_FAKE' }));
  const result = await f.runtime.exportDocument(args);
  assert.equal(result.status, 'dependency_missing');
  assert.equal(JSON.stringify(result).includes('SENSITIVE_FAKE'), false);
  const unknown = fixture({}, () => ({ status: 'error', code: 'SENSITIVE_FAKE' }));
  assert.equal((await unknown.runtime.exportDocument(args)).status, 'document_export_failed');
});
