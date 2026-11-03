import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { createRuntime } from '../lib/runtime.mjs';
import { createToolDefinitions } from '../lib/adapter.mjs';

const styles = [
  { value: 'verbatim', label: '原文（完全复述）' },
  { value: 'concise', label: '简要压缩' },
  { value: 'summary', label: '总结' },
];
const target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=28';
const workspace = resolve('choice-fixture-workspace');
const python = resolve('choice-fixture-python.exe');
const exportArgs = { title: '边界回归', markdown: '## 正文\n\n完整内容。' };
const rawTranscript = '第一段完整字幕。\n第二段不能被任何简略度截断。\n第三段包括重复与细节。';

// No default outputStyle and no extract wrapper: every choice regression calls
// the production createRuntime object directly. All side effects are fakes.
function fixture(config = {}, overrides = {}) {
  const calls = [], scratches = [], accesses = [], workspaces = [], auth = [], uuids = [];
  const runtime = createRuntime(config, {
    root: resolve('.'),
    getWorkspace: async execution => { workspaces.push(execution); return workspace; },
    accessImpl: async path => { accesses.push(path); throw Error('fixture has no managed Python'); },
    createScratchImpl: async base => {
      const scratch = { base, path: join(base, '.fake-choice-scratch-' + (scratches.length + 1)), disposals: 0 };
      scratches.push(scratch);
      return { path: scratch.path, dispose: async () => { scratch.disposals++; } };
    },
    uuidImpl: () => { uuids.push('choice-request'); return 'choice-request'; },
    getBiliCredential: async () => { auth.push(true); return { source: 'anonymous' }; },
    terminateImpl: async child => { child.kill(); return true; },
    spawnImpl(command, argv, options) {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
      const call = { command, argv, options, input: '' }; calls.push(call);
      child.stdin.on('data', data => { call.input += data; });
      child.stdin.once('finish', () => queueMicrotask(() => {
        if (argv.includes('-c')) child.stdout.write(JSON.stringify({ executable: python, version: [3, 13] }));
        else {
          call.request = JSON.parse(call.input);
          const response = call.request.directory
            ? { status: 'ok', document_file: join(call.request.directory, 'fixture.' + call.request.format) }
            : { status: 'ok', transcript: rawTranscript, segments: [
              { start: 0, text: '第一段完整字幕。' }, { start: 20, text: '第二段不能被任何简略度截断。' },
              { start: 40, text: '第三段包括重复与细节。' },
            ], network_used: false };
          child.stdout.write(JSON.stringify(response));
        }
        child.emit('close', 0);
      }));
      return child;
    },
    ...overrides,
  });
  return { runtime, calls, scratches, accesses, workspaces, auth, uuids,
    requests: () => calls.filter(call => call.request).map(call => call.request) };
}
function noEffects(f) {
  for (const name of ['calls', 'scratches', 'accesses', 'workspaces', 'auth', 'uuids'])
    assert.deepEqual(f[name], [], name + ' must remain untouched');
}
function trappedConfig() {
  const reads = [];
  const config = new Proxy({}, { get(_target, name) { reads.push(name); throw Error('must not read config ' + String(name)); } });
  return { config, reads };
}
function assertChoiceRequired(result) {
  assert.deepEqual({ status: result.status, success: result.success, question: result.question, choices: result.choices },
    { status: 'output_style_required', success: false, question: '本次转写以什么简略度输出？', choices: styles });
}

test('missing outputStyle asks before all config, secrets, auth, workspace, filesystem and spawn access', async () => {
  for (const args of [{ target }, { target, forceAsr: true }, { target, captionsOnly: true }, {}]) {
    const { config, reads } = trappedConfig(), f = fixture(config);
    assertChoiceRequired(await f.runtime.extract(args));
    assert.deepEqual(reads, []); noEffects(f);
  }
});

test('missing choice never guesses from configured values or a previous extraction', async () => {
  const f = fixture({ outputStyle: 'summary' });
  for (const { value, label } of styles) {
    const selected = await f.runtime.extract({ target, outputStyle: value });
    assert.equal(selected.status, 'ok'); assert.equal(selected.output_style, value);
    assert.equal(selected.output_style_label, label);
    const before = [f.calls.length, f.scratches.length, f.accesses.length, f.workspaces.length, f.auth.length, f.uuids.length];
    assertChoiceRequired(await f.runtime.extract({ target }));
    assert.deepEqual([f.calls.length, f.scratches.length, f.accesses.length, f.workspaces.length, f.auth.length, f.uuids.length], before);
  }
});

test('invalid outputStyle is rejected without config or any extraction side effect', async () => {
  for (const outputStyle of [null, '', 'original', 'VERBATIM', ' summary ', false, 0, [], {}, ['summary']]) {
    const { config, reads } = trappedConfig(), f = fixture(config);
    const result = await f.runtime.extract({ target, outputStyle });
    assert.equal(result.status, 'invalid_input'); assert.equal(result.success, false);
    assert.deepEqual(reads, []); noEffects(f);
  }
});

test('pre-cancellation wins over missing, invalid and valid output choice without reading config', async () => {
  for (const args of [{ target }, { target, outputStyle: 'bad' }, ...styles.map(style => ({ target, outputStyle: style.value }))]) {
    const controller = new AbortController(); controller.abort();
    const { config, reads } = trappedConfig(), f = fixture(config);
    const result = await f.runtime.extract(args, { signal: controller.signal });
    assert.equal(result.status, 'cancelled'); assert.equal(result.success, false);
    assert.deepEqual(reads, []); noEffects(f);
  }
});

test('all output choices preserve complete captions and identical Python stdin requests', async () => {
  for (const mode of ['captions', 'cloud']) {
    const requests = [];
    for (const { value, label } of styles) {
      const f = fixture({ mode, cloudEndpoint: 'https://asr.example.invalid/v1/audio/transcriptions',
        cloudApiKey: 'FAKE_CHOICE_KEY', cloudModel: 'full-transcription-model', cloudUploadConsent: true });
      const result = await f.runtime.extract({ target, outputStyle: value, language: 'zh', reason: 'unreliable_captions', forceAsr: mode === 'cloud' });
      assert.equal(result.status, 'ok'); assert.equal(result.output_style, value); assert.equal(result.output_style_label, label);
      assert.equal(result.transcript, rawTranscript); assert.equal(result.segments.length, 3);
      assert.equal(result.segments.at(-1).text, '第三段包括重复与细节。');
      const [request] = f.requests(); requests.push(request);
      assert.deepEqual(Object.keys(request).sort(), ['operation', 'config', 'target', 'language', 'reason', 'forceAsr', 'captionsOnly', 'out'].sort());
      assert.equal(request.target, target); assert.equal(request.language, 'zh'); assert.equal(request.reason, 'unreliable_captions');
      assert.equal(request.forceAsr, mode === 'cloud'); assert.equal(request.captionsOnly, false);
      assert.equal(request.config.mode, mode);
      assert.equal(request.out, join(workspace, 'video-study', 'transcripts', 'dsh-video-study-choice-request'));
      assert.equal('outputStyle' in request.config, false); assert.equal('output_style' in request.config, false);
      if (mode === 'cloud') {
        assert.equal(request.config.cloudModel, 'full-transcription-model');
        assert.equal(request.config.cloudUploadConsent, true); assert.equal(request.config.cloudApiKey, 'FAKE_CHOICE_KEY');
      }
      assert.equal(f.calls.length, 2); assert.equal(f.auth.length, 1); assert.equal(f.scratches[0].disposals, 1);
      assert.equal(f.calls.some(call => JSON.stringify(call.argv).includes('FAKE_CHOICE_KEY')), false);
    }
    assert.deepEqual(requests[1], requests[0]); assert.deepEqual(requests[2], requests[0]);
  }
});

test('outputStyle is a required enum in native tool schema and passed through unchanged', async () => {
  const received = [], runtime = { extract: async (...args) => { received.push(args); return { status: 'fixture' }; } };
  const tool = createToolDefinitions({}, runtime)[1];
  assert.equal(tool.parameters.outputStyle.type, 'string'); assert.equal(tool.parameters.outputStyle.required, true);
  assert.deepEqual(tool.parameters.outputStyle.enum, styles.map(style => style.value));
  assert.equal(Object.hasOwn(tool.parameters.outputStyle, 'default'), false);
  for (const { value } of styles) {
    const args = { target, outputStyle: value }, execution = { agent: { id: 'choice-test' } };
    assert.equal((await tool.execute(args, execution)).status, 'fixture');
    assert.equal(received.at(-1)[0], args); assert.equal(received.at(-1)[1], execution);
  }
});

const invalidResolvers = [
  ['throws', async () => { throw Error('PRIVATE_RESOLVER_ERROR'); }],
  ...[null, '', 'relative-workspace', 42, {}, resolve('invalid') + '/..', '\\\\server\\share', resolve('bad') + '\0'].map(value => [String(value), async () => value]),
];
const operationArgs = operation => operation === 'extract' ? { target, outputStyle: 'verbatim' }
  : operation === 'exportDocument' ? exportArgs : {};
const explicitField = operation => ({ extract: 'outputDir', exportDocument: 'documentOutputDir', setup: 'stateDir' })[operation];

test('corresponding explicit bases survive unavailable workspace; writing tasks use their base as cwd', async () => {
  for (const [name, getWorkspace] of invalidResolvers) for (const operation of ['extract', 'exportDocument', 'setup']) {
    const base = resolve('explicit-' + operation), f = fixture({ [explicitField(operation)]: base }, { getWorkspace });
    const result = await f.runtime[operation](operationArgs(operation));
    assert.equal(result.status, operation === 'setup' ? 'setup_command_prepared' : 'ok', name + ':' + operation);
    assert.ok(f.calls.length > 0);
    // setup only probes Python and prepares a command. Its state directory may
    // not exist yet, so do not require/create it as cwd before manual deployment.
    if (operation === 'setup') assert.ok(f.calls.every(call => call.options.cwd === undefined));
    else assert.ok(f.calls.every(call => call.options.cwd === base), name + ':' + operation + ' cwd');
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESOLVER_ERROR'), false);
    if (operation === 'extract') assert.equal(resolve(f.requests()[0].out, '..'), base);
    if (operation === 'exportDocument') assert.equal(f.requests()[0].directory, base);
    if (operation === 'setup') { assert.equal(result.state_dir, base); assert.equal(f.scratches.length, 0); }
    assert.ok(f.scratches.every(scratch => scratch.base === base && scratch.disposals === 1));
  }
});

test('unavailable workspace without an explicit base fails closed for task outputs', async () => {
  for (const [name, getWorkspace] of invalidResolvers) for (const operation of ['extract', 'exportDocument']) {
    const unrelated = { outputDir: resolve('other-output'), documentOutputDir: resolve('other-documents'), stateDir: resolve('other-state') };
    delete unrelated[explicitField(operation)];
    const f = fixture(unrelated, { getWorkspace });
    const result = await f.runtime[operation](operationArgs(operation));
    assert.equal(result.status, 'workspace_required', name + ':' + operation);
    assert.equal(f.calls.length, 0); assert.equal(f.scratches.length, 0); assert.equal(f.accesses.length, 0); assert.equal(f.auth.length, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESOLVER_ERROR'), false);
  }
  // 运行环境是宿主安装而非任务产物：设置页没有可用会话时仍应能生成部署命令。
  for (const [name, getWorkspace] of invalidResolvers) {
    const f = fixture({ outputDir: resolve('other-output'), documentOutputDir: resolve('other-documents') }, { getWorkspace });
    const result = await f.runtime.setup();
    assert.equal(result.status, 'setup_command_prepared', name);
    assert.equal(f.scratches.length, 0); assert.equal(f.auth.length, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESOLVER_ERROR'), false);
  }
});

test('offline status tolerates unavailable resolver and probes only the hosted environment', async () => {
  for (const [name, getWorkspace] of invalidResolvers) {
    const config = { mode: 'captions' };
    for (const key of ['cloudApiKey', 'cloudApiKeyFile']) Object.defineProperty(config, key, { get() { assert.fail('status must not read ' + key); } });
    const f = fixture(config, { getWorkspace });
    const result = await f.runtime.status();
    assert.equal(result.status, 'ok', name); assert.equal(result.network_used, false);
    assert.equal(f.scratches.length, 0); assert.equal(f.auth.length, 0);
    // 只读探测托管位置的一个解释器，不写文件、不回退系统临时目录。
    assert.ok(f.accesses.length <= 1, name);
    assert.deepEqual(f.requests().map(request => request.operation), ['status']);
  }
});

test('optional workspace failure never hides cancellation before or during resolver', async () => {
  for (const operation of ['extract', 'exportDocument', 'setup', 'status']) for (const failure of ['throw', 'invalid', 'valid']) {
    const controller = new AbortController();
    const f = fixture({ outputDir: resolve('cancel-output'), documentOutputDir: resolve('cancel-documents'), stateDir: resolve('cancel-state') }, {
      getWorkspace: async () => {
        controller.abort();
        if (failure === 'throw') throw Error('PRIVATE_CANCELLED_RESOLVER');
        return failure === 'invalid' ? 'relative-workspace' : workspace;
      },
    });
    const result = await f.runtime[operation](operationArgs(operation), { signal: controller.signal });
    assert.equal(result.status, 'cancelled', operation + ':' + failure);
    assert.equal(f.calls.length, 0); assert.equal(f.scratches.length, 0); assert.equal(f.auth.length, 0); assert.equal(f.accesses.length, 0);
    const preAborted = fixture({}, { getWorkspace: async () => { assert.fail('pre-cancelled resolver must not run'); } });
    assert.equal((await preAborted.runtime[operation](operationArgs(operation), { signal: controller.signal })).status, 'cancelled');
    noEffects(preAborted);
  }
});
