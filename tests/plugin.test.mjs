import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRuntime, DEFAULTS, extractionBudgetMs, sanitizeResult, terminateProcessTree } from '../lib/runtime.mjs';
import { applyPlugin, createConfig, createSkillProvider, createToolDefinitions } from '../lib/adapter.mjs';

const KEY = 'unit-test-key-DO-NOT-LEAK';
const executable = resolve('fake-python.exe');
const root = resolve('packages/dsh-video-study');
const home = join(tmpdir(), 'video-study-test-home');

function harness(config = {}, options = {}) {
  const calls = [];
  let counter = 0;
  const spawnImpl = (command, args, spawnOptions) => {
    const record = { command, args, options: spawnOptions, stdin: '', kills: [], request: undefined };
    calls.push(record);
    if (options.spawnError) throw Object.assign(new Error('sensitive dependency diagnostic'), { code: options.spawnError });
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    record.child = child;
    child.stdin.on('data', data => { record.stdin += data; });
    child.kill = signal => {
      record.kills.push(signal);
      if (!options.neverExit) queueMicrotask(() => child.emit('close', null));
      return true;
    };
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        if (args.includes('-c')) {
          if (options.badProbe) {
            child.stdout.write('invalid probe'); child.emit('close', 1); return;
          }
          child.stdout.write(JSON.stringify({ executable, version: [3, 13] }));
          child.emit('close', 0);
          return;
        }
        record.request = JSON.parse(record.stdin);
        options.onRequest?.(record.request, record);
        if (options.hang) return;
        const response = options.response ?? (record.request.operation === 'status'
          ? { status: 'dependency_missing', network_used: false, runtime_ready: false }
          : { status: 'ok', output: record.request.out, caption_kind: 'manual', warnings: [] });
        child.stdout.write(options.rawStdout ?? JSON.stringify(response));
        child.emit('close', options.exitCode ?? (response.status === 'ok' ? 0 : 2));
      });
    });
    return child;
  };
  const runtime = createRuntime(config, { spawnImpl, root,
    accessImpl: async () => { throw new Error('not installed'); },
    homedirImpl: () => home, tmpdirImpl: () => tmpdir(), uuidImpl: () => `test-uuid-${++counter}`,
    platform: process.platform, terminateImpl: async child => { child.kill('SIGTERM'); },
    ...options.dependencies });
  return { runtime, calls, requests: () => calls.filter(call => !call.args.includes('-c')).map(call => call.request) };
}

function unavailableCloudConfig(mode = 'captions') {
  const config = { mode };
  for (const key of ['cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudModel', 'cloudUploadConsent', 'cloudMaxAudioMiB']) {
    Object.defineProperty(config, key, { enumerable: true, get() { throw new Error(`must not read ${key}`); } });
  }
  return config;
}

// A tiny schema recorder checks use of the native ABI without installing an SDK.
function fakeSchemastery() {
  const make = (kind, choices) => ({ kind, choices, default(value) { this.defaultValue = value; return this; },
    role(value) { this.roleValue = value; return this; },
    volatile() { this.live = true; return this; },
    description(value) { this.descriptionValue = value; return this; } });
  return { object: shape => ({ shape }), string: () => make('string'), boolean: () => make('boolean'),
    number: () => make('number'), union: choices => make('union', choices) };
}

const BILI_URL = 'https://www.bilibili.com/video/BV17K411P7hC/?p=28';
const SESSION = 'FAKE_MANAGED_BILI_SESSION_ONLY';
const ref = initial => ({ value: initial, get() { return this.value; }, set(value) { this.value = value; } });

test('native live refs change the next extraction without recreating runtime', async () => {
  const mode = ref('captions'), endpoint = ref('https://asr.example/v1/audio/transcriptions');
  const key = ref(KEY), consent = ref(false), modelDir = ref(resolve('fake-local-model'));
  const h = harness({ mode, cloudEndpoint: endpoint, cloudApiKey: key, cloudModel: ref('model'),
    cloudUploadConsent: consent, localModelDir: modelDir });
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[0].config.mode, 'captions');
  assert.equal('cloudApiKey' in h.requests()[0].config, false);
  mode.set('cloud'); consent.set(true);
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[1].config.mode, 'cloud');
  assert.equal(h.requests()[1].config.cloudApiKey, KEY);
  assert.equal(h.requests()[1].config.cloudUploadConsent, true);
  assert.equal(h.requests()[1].config.cloudEndpoint, endpoint.value);
  mode.set('local');
  key.get = () => { throw Error('local must not read cloud key'); };
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[2].config.mode, 'local');
  assert.equal(h.requests()[2].config.localModelDir, modelDir.value);
});

test('caption-only with volatile config never dereferences unselected ASR secrets or limits', async () => {
  const config = { mode: ref('cloud') };
  for (const field of ['cloudApiKey', 'cloudEndpoint', 'cloudUploadConsent', 'asrTimeout', 'localModelDir'])
    config[field] = { get() { throw Error('must not read ' + field); } };
  const h = harness(config);
  assert.equal((await h.runtime.extract({ target: 'abcdefghijk', captionsOnly: true })).status, 'ok');
  assert.equal(h.requests()[0].config.mode, 'captions');
});

test('an in-flight extraction keeps one settings snapshot while the next uses the saved values', async () => {
  const mode = ref('cloud'), key = ref(KEY), endpoint = ref('https://old.example/v1/audio/transcriptions');
  const pythonPath = ref(resolve('old-python.exe')), outputDir = ref(resolve('old-output'));
  let release;
  const gate = new Promise(resolveDone => { release = resolveDone; });
  const h = harness({ mode, cloudApiKey: key, cloudEndpoint: endpoint, cloudModel: ref('model'),
    pythonPath, outputDir }, { dependencies: { getBiliCredential: async () => { await gate; return { source: 'anonymous' }; } } });
  const pending = h.runtime.extract({ target: BILI_URL });
  mode.set('local'); pythonPath.set(resolve('new-python.exe')); outputDir.set(resolve('new-output'));
  endpoint.set('https://new.example/v1/audio/transcriptions');
  release(); await pending;
  assert.equal(h.requests()[0].config.mode, 'cloud');
  assert.equal(h.requests()[0].config.cloudEndpoint, 'https://old.example/v1/audio/transcriptions');
  assert.ok(h.requests()[0].out.startsWith(resolve('old-output')));
  assert.equal(h.calls[0].command, resolve('old-python.exe'));
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[1].config.mode, 'local');
  assert.ok(h.requests()[1].out.startsWith(resolve('new-output')));
  assert.equal(h.calls[2].command, resolve('new-python.exe'));
});

test('setup snapshots live Python, state and model fields before asynchronous probing', async () => {
  const mode = ref('local'), model = ref('small'), state = ref(resolve('old-state')), proxy = ref('');
  const h = harness({ mode, localModel: model, stateDir: state, proxy });
  const pending = h.runtime.setup();
  model.set('tiny'); state.set(resolve('new-state')); proxy.set('http://127.0.0.1:8080');
  const first = await pending;
  assert.equal(first.status, 'setup_command_prepared');
  assert.equal(first.local_model_dir, join(resolve('old-state'), 'models', 'small'));
  assert.equal(first.command.includes('--proxy'), false);
  const second = await h.runtime.setup();
  assert.equal(second.local_model_dir, join(resolve('new-state'), 'models', 'tiny'));
  assert.equal(second.command.includes('--proxy'), true);
});

test('volatile update refreshes declared tool timeout without disposing the active runtime', async () => {
  const mode = ref('captions'), listeners = {}, effects = [], active = new Map();
  let disposed = false, registrations = 0;
  const runtime = { status: async () => ({ status: 'test' }), extract: async () => ({ status: 'test' }),
    setup: async () => ({ status: 'test' }), dispose: async () => { disposed = true; } };
  const ctx = { tools: { register(definition) { registrations++; active.set(definition.name, definition);
    return () => { if (active.get(definition.name) === definition) active.delete(definition.name); }; } },
    on(name, callback) { listeners[name] = callback; }, effect(callback) { effects.push(callback()); },
    inject() {} };
  applyPlugin(ctx, { mode, registerSkill: false }, { defineTool: value => value, runtimeFactory: () => runtime });
  assert.equal(active.get('video_study_extract').timeoutMs, extractionBudgetMs({ mode: 'captions' }, 150));
  mode.set('cloud'); listeners['loader/volatile-update'](['mode']);
  assert.equal(active.get('video_study_extract').timeoutMs, extractionBudgetMs({ mode: 'cloud' }, 150));
  assert.equal(registrations, 6); assert.equal(active.size, 3); assert.equal(disposed, false);
  await effects[0](); assert.equal(disposed, true); assert.equal(active.size, 0);
});

test('managed Bilibili session travels only in private stdin, not argv or a cookie file', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'managed', sessdata: SESSION }) },
    response: { status: 'ok', echo: SESSION, sessdata: SESSION, qrUrl: 'private' } });
  const result = await h.runtime.extract({ target: BILI_URL, captionsOnly: true });
  assert.equal(result.status, 'ok');
  assert.equal(h.requests()[0].config.biliSessdata, SESSION);
  assert.equal(h.requests()[0].config.biliCookieFile, '');
  assert.ok(h.calls.every(call => !JSON.stringify(call.args).includes(SESSION)));
  assert.ok(!JSON.stringify(result).includes(SESSION));
  assert.equal('sessdata' in result, false); assert.equal('qrUrl' in result, false);
});

test('YouTube, status and setup do not ask for managed Bilibili credentials', async () => {
  const h = harness({}, { dependencies: { getBiliCredential: async () => { throw Error('must not read'); } } });
  assert.equal((await h.runtime.extract({ target: 'https://www.youtube.com/watch?v=abcdefghijk' })).status, 'ok');
  await h.runtime.status(); await h.runtime.setup();
  assert.ok(h.requests().every(request => !('biliSessdata' in request.config)));
});

test('logout anonymous selection disables configured old cookie file without another account fallback', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'anonymous' }) } });
  assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'ok');
  assert.equal(h.requests()[0].config.biliCookieFile, '');
  assert.equal('biliSessdata' in h.requests()[0].config, false);
});

test('legacy explicit file remains available only when auth service selects it', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'legacy_file' }) } });
  await h.runtime.extract({ target: BILI_URL });
  assert.equal(h.requests()[0].config.biliCookieFile, 'explicit-old-file.json');
});

test('expired managed or invalid credentials fail before Python without fallback', async () => {
  for (const credential of [{ source: 'managed' }, { source: 'managed', sessdata: 'bad;injected' }, { source: 'unexpected' }]) {
    const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: { getBiliCredential: async () => credential } });
    assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'login_required');
    assert.equal(h.calls.length, 0);
  }
});

test('private credential provider errors and timeouts do not expose raw text', async () => {
  for (const callback of [async () => { throw Error(SESSION); }, () => new Promise(() => {})]) {
    const h = harness({}, { dependencies: { getBiliCredential: callback, authTimeoutMs: 5 } });
    const result = await h.runtime.extract({ target: BILI_URL });
    assert.equal(result.status, 'login_required'); assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(SESSION));
  }
});

test('lookalike Bilibili host does not obtain managed credentials', async () => {
  const h = harness({}, { dependencies: { getBiliCredential: async () => { throw Error('must not read'); } } });
  await h.runtime.extract({ target: 'https://www.bilibili.com.evil.example/video/BV17K411P7hC/' });
  assert.equal('biliSessdata' in h.requests()[0].config, false);
});

test('rejected request reports the exact old session privately for race-safe invalidation', async () => {
  const rejected = [];
  const h = harness({}, { dependencies: { getBiliCredential: async () => ({ source: 'managed', sessdata: SESSION }),
    onBiliRejected: async expected => rejected.push(expected) }, response: { status: 'login_required' } });
  assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'login_required');
  assert.deepEqual(rejected, [SESSION]);
});

test('tool parameters cannot supply managed sessions or drive login flows', async () => {
  for (const key of ['biliSessdata', 'flowId', 'qrUrl']) {
    const h = harness();
    assert.equal((await h.runtime.extract({ target: BILI_URL, [key]: SESSION })).status, 'invalid_input');
    assert.equal(h.calls.length, 0);
  }
});

test('defaults are portable, captions-only and do not authorize upload', () => {
  assert.equal(DEFAULTS.mode, 'captions');
  assert.equal(DEFAULTS.cloudUploadConsent, false);
  assert.equal(DEFAULTS.localDevice, 'cpu');
  assert.equal(DEFAULTS.localComputeType, 'int8');
  assert.equal(DEFAULTS.defaultLanguage, 'auto');
  assert.equal(JSON.stringify(DEFAULTS).includes('enana'), false);
});

test('native Config exposes live mode and secret fields without losing the secret UI role', () => {
  const schema = createConfig(fakeSchemastery()).shape;
  assert.deepEqual(schema.mode.choices, ['captions', 'cloud', 'local']);
  assert.equal(schema.mode.defaultValue, 'captions');
  assert.equal(schema.cloudApiKey.roleValue, 'secret');
  for (const name of ['mode', 'defaultLanguage', 'cloudApiKey', 'cloudUploadConsent', 'localModelDir', 'pythonPath'])
    assert.equal(schema[name].live, true);
  assert.equal(schema.cloudUploadConsent.defaultValue, false);
  for (const field of ['pythonPath', 'stateDir', 'outputDir', 'localModelDir', 'cloudEndpoint', 'cloudApiKeyFile', 'proxy'])
    assert.equal(schema[field].defaultValue, '');
  assert.equal(schema.localModel.defaultValue, 'small');
  assert.equal(schema.defaultLanguage.defaultValue, 'auto');
  for (const name of ['mode', 'localModel', 'cloudEndpoint', 'cloudUploadConsent'])
    assert.equal(typeof schema[name].descriptionValue, 'string');
});

test('status is an offline runner request without cloud credential access in captions mode', async () => {
  const { runtime, calls, requests } = harness(unavailableCloudConfig());
  const result = await runtime.status({});
  assert.equal(result.status, 'dependency_missing');
  assert.equal(result.network_used, false);
  assert.equal(result.runtime_ready, false);
  const request = requests()[0];
  assert.equal(request.operation, 'status');
  assert.equal(request.config.mode, 'captions');
  assert.equal('cloudApiKey' in request.config, false);
  assert.equal('localModelDir' in request.config, false);
  assert.equal('target' in request, false);
  assert.equal('out' in request, false);
  assert.equal(calls.every(call => call.options.shell === false), true);
  assert.equal(calls.every(call => call.options.stdio[2] === 'ignore'), true);
});

test('captionsOnly is a one-way restriction and never reads cloud getters', async () => {
  const { runtime, requests } = harness(unavailableCloudConfig('cloud'));
  const result = await runtime.extract({ target: 'abcdefghijk', captionsOnly: true });
  assert.equal(result.status, 'ok');
  assert.equal(requests()[0].config.mode, 'captions');
  assert.equal(requests()[0].captionsOnly, true);
});

test('local mode never reads cloud configuration and uses portable state model directory', async () => {
  const { runtime, requests } = harness(unavailableCloudConfig('local'));
  assert.equal((await runtime.extract({ target: 'abcdefghijk', language: 'en' })).status, 'ok');
  const request = requests()[0];
  assert.equal(request.config.mode, 'local');
  assert.equal(request.config.localModelDir, '');
  assert.equal(request.config.localModel, 'small');
  assert.equal(request.config.stateDir, join(home, '.dsh', 'state', 'dsh-video-study'));
  assert.equal(request.config.localDevice, 'cpu');
  assert.equal(request.config.localComputeType, 'int8');
  assert.equal(request.language, 'en');
});

test('no tool argument can opt into cloud or provide a secret/output override', async () => {
  for (const extra of [{ mode: 'cloud' }, { cloudApiKey: KEY }, { out: resolve('bad-output') }, { config: { mode: 'cloud' } }]) {
    const { runtime, calls } = harness();
    const result = await runtime.extract({ target: 'abcdefghijk', ...extra });
    assert.equal(result.status, 'invalid_input');
    assert.equal(calls.length, 0);
  }
});

test('forceAsr in captions mode is rejected before Python/network activity', async () => {
  const { runtime, calls } = harness();
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true })).status, 'mode_restricted');
  assert.equal(calls.length, 0);
});

test('captionsOnly plus forceAsr cannot escape configured ASR restrictions', async () => {
  const { runtime, calls } = harness({ mode: 'local' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true, captionsOnly: true })).status, 'mode_restricted');
  assert.equal(calls.length, 0);
});

test('cloud forced ASR requires consent independently of mode', async () => {
  const { runtime, calls } = harness({ mode: 'cloud', cloudApiKey: KEY, cloudUploadConsent: false });
  const result = await runtime.extract({ target: 'abcdefghijk', forceAsr: true });
  assert.equal(result.status, 'upload_consent_required');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('cloud without consent still permits ordinary existing-caption extraction', async () => {
  const { runtime, requests } = harness({ mode: 'cloud', cloudUploadConsent: false });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  assert.equal(result.status, 'ok');
  assert.equal(requests()[0].config.cloudUploadConsent, false);
  assert.equal(requests()[0].forceAsr, false);
});

test('unconfigured ASR backends do not preflight models/endpoints before valid captions', async () => {
  for (const config of [
    { mode: 'local', localModelDir: join(tmpdir(), 'nonexistent-video-study-model') },
    { mode: 'cloud', cloudEndpoint: 'not-a-usable-endpoint', cloudModel: '', cloudApiKeyFile: 'missing-keyfile', cloudUploadConsent: false },
  ]) {
    const { runtime, requests } = harness(config);
    assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
    assert.equal(requests().length, 1);
    assert.equal(requests()[0].operation, 'extract');
    assert.equal(requests()[0].forceAsr, false);
  }
});

test('cloud audio size is preserved for Python fallback validation, not enforced before captions', async () => {
  const accepted = harness({ mode: 'cloud', cloudMaxAudioMiB: 512 });
  assert.equal((await accepted.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(accepted.requests()[0].config.cloudMaxAudioMiB, 512);
  const caption = harness({ mode: 'cloud', cloudMaxAudioMiB: 513 });
  assert.equal((await caption.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(caption.requests()[0].config.cloudMaxAudioMiB, 513);
  const denied = harness({ mode: 'cloud', cloudMaxAudioMiB: 513 }, { response: { status: 'invalid_input', success: false } });
  assert.equal((await denied.runtime.status({})).status, 'invalid_input');
  assert.equal(denied.requests()[0].config.cloudMaxAudioMiB, 513);
});

test('zero, negative and relative-state ASR settings cannot block existing captions', async () => {
  const fixtures = [
    { mode: 'captions', asrTimeout: 0, downloadTimeout: -1, maxDuration: -1,
      stateDir: 'relative-state', localModel: 'unsupported', cloudMaxAudioMiB: 0 },
    { mode: 'cloud', asrTimeout: 0, downloadTimeout: -1, maxDuration: 0,
      stateDir: 'relative-state', cloudMaxAudioMiB: -1, cloudEndpoint: null, cloudModel: null },
    { mode: 'local', asrTimeout: -1, downloadTimeout: 0, maxDuration: -1,
      stateDir: 'relative-state', localModelDir: 'relative-model', localModel: 'unsupported',
      localDevice: 'unsupported', localComputeType: null },
  ];
  for (const config of fixtures) {
    const { runtime, requests } = harness(config);
    const result = await runtime.extract({ target: 'abcdefghijk' });
    assert.equal(result.status, 'ok', JSON.stringify(config));
    assert.equal(result.caption_kind, 'manual');
    const forwarded = requests()[0].config;
    if (config.mode === 'captions') {
      for (const field of ['asrTimeout', 'downloadTimeout', 'maxDuration', 'localModel', 'cloudMaxAudioMiB'])
        assert.equal(field in forwarded, false);
    } else {
      for (const field of ['asrTimeout', 'downloadTimeout', 'maxDuration'])
        assert.equal(forwarded[field], config[field]);
      if (config.mode === 'local') {
        assert.equal(forwarded.stateDir, 'relative-state');
        assert.equal(forwarded.localModel, 'unsupported');
        assert.equal(forwarded.localModelDir, 'relative-model');
        assert.equal(forwarded.localComputeType, null);
      } else assert.equal(forwarded.cloudMaxAudioMiB, -1);
    }
  }
});

test('caption-only ignores backend-only limit/model getters and unusable managed state', async () => {
  const config = unavailableCloudConfig();
  for (const key of ['asrTimeout', 'downloadTimeout', 'maxDuration', 'localModel', 'localModelDir', 'localDevice', 'localComputeType', 'stateDir'])
    Object.defineProperty(config, key, { get() { throw new Error(`must not read backend setting ${key}`); } });
  const { runtime, requests } = harness(config);
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.deepEqual(Object.keys(requests()[0].config).sort(), ['mode', 'proxy', 'youtubeCookieFile', 'biliCookieFile'].sort());
});

test('safe default scheduling does not validate ASR or read it for caption-only', () => {
  assert.equal(extractionBudgetMs({ mode: 'local', downloadTimeout: -1, asrTimeout: 0 }), 7620000);
  assert.equal(extractionBudgetMs({ mode: 'cloud', downloadTimeout: NaN, asrTimeout: 'bad' }), 7620000);
  const captions = { mode: 'captions', get asrTimeout() { throw new Error('unrelated'); },
    get downloadTimeout() { throw new Error('unrelated'); } };
  assert.equal(extractionBudgetMs(captions), 420000);
  assert.equal(createToolDefinitions(captions, {})[1].timeoutMs, 450000);
  assert.equal(createToolDefinitions({ mode: 'local', asrTimeout: 0, downloadTimeout: -1 }, {})[1].timeoutMs, 7650000);
});

test('relative stateDir skips only managed discovery, while setup remains strict', async () => {
  const { runtime, calls } = harness({ stateDir: 'relative-state' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(calls[0].command, process.platform === 'win32' ? 'python' : 'python3');
  assert.equal((await runtime.setup({})).status, 'invalid_config');
});

test('backend invalid settings are forwarded unmodified and Python failures pass through', async () => {
  const { runtime, requests } = harness({ mode: 'cloud', cloudUploadConsent: true,
    asrTimeout: 0, maxDuration: -1, cloudMaxAudioMiB: 0 }, { response: { status: 'invalid_input', success: false } });
  const result = await runtime.extract({ target: 'abcdefghijk', forceAsr: true });
  assert.equal(result.status, 'invalid_input');
  assert.equal(requests()[0].config.asrTimeout, 0);
  assert.equal(requests()[0].config.cloudMaxAudioMiB, 0);
  assert.equal(requests()[0].forceAsr, true);
});

test('cloud secret is stdin-only; keyfile is forwarded as path without being read', async () => {
  const { runtime, calls, requests } = harness({ mode: 'cloud', cloudApiKey: KEY,
    cloudApiKeyFile: resolve('explicit-nonexistent-keyfile'), cloudUploadConsent: true,
    cloudEndpoint: 'https://api.example.invalid/v1', cloudModel: 'whisper-1' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true })).status, 'ok');
  const request = requests()[0];
  assert.equal(request.config.cloudApiKey, KEY);
  assert.equal(request.config.cloudApiKeyFile, resolve('explicit-nonexistent-keyfile'));
  assert.equal(calls.some(call => call.args.join(' ').includes(KEY)), false);
  assert.equal(calls.some(call => call.args.join(' ').includes('api.example.invalid')), false);
  assert.equal(calls[1].args[0], '-B');
  assert.equal(calls[1].args[1], join(root, 'python', 'runner.py'));
  assert.equal(calls[1].args.length, 2);
});

test('runner result cannot expose key or signed URLs, even in nested errors', async () => {
  const response = { status: 'network_error', api_key: KEY,
    message: `failure ${KEY} at https://cdn.example.invalid/media?signature=SENSITIVE`,
    source_url: 'https://www.youtube.com/watch?v=abcdefghijk&signature=SENSITIVE',
    nested: { authorization: `Bearer ${KEY}`, raw: KEY, signature: 'SENSITIVE' } };
  const { runtime } = harness({ mode: 'cloud', cloudApiKey: KEY }, { response });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes('SENSITIVE'), false);
  assert.equal(serialized.includes('cdn.example.invalid'), false);
  assert.equal(result.source_url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal('authorization' in result.nested, false);
});

test('new absolute unique output names are generated without mkdir/overwriting', async () => {
  const base = join(tmpdir(), `video-study-test-${Date.now()}`);
  const { runtime, requests } = harness({ outputDir: base });
  await runtime.extract({ target: 'abcdefghijk' });
  await runtime.extract({ target: 'abcdefghijk' });
  const [first, second] = requests();
  assert.equal(isAbsolute(first.out), true);
  assert.equal(first.out, join(base, 'dsh-video-study-test-uuid-1'));
  assert.notEqual(first.out, second.out);
  await assert.rejects(access(base));
  assert.equal(first.language, 'auto');
});

test('configured default language is honored, explicit selection overrides it', async () => {
  const { runtime, requests } = harness({ defaultLanguage: 'en' });
  await runtime.extract({ target: 'abcdefghijk' });
  await runtime.extract({ target: 'abcdefghijk', language: 'zh' });
  assert.deepEqual(requests().map(request => request.language), ['en', 'zh']);
});

test('relative outputDir is refused without running the runner', async () => {
  const { runtime, requests } = harness({ outputDir: 'relative-output' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'invalid_config');
  assert.equal(requests().length, 0);
});

test('automatic Python discovery never binds to the original D drive venv', async () => {
  const { runtime, calls } = harness();
  await runtime.status({});
  assert.equal(calls[0].args.includes('-c'), true);
  assert.equal(calls[1].command, executable);
  assert.equal(JSON.stringify(calls.map(({ command, args }) => ({ command, args }))).includes('D:\\project'), false);
});

test('explicit Python path with spaces stays a single executable, no shell parsing', async () => {
  const custom = join(tmpdir(), 'Python with spaces', 'python.exe');
  const { runtime, calls } = harness({ pythonPath: custom });
  await runtime.status({});
  assert.equal(calls[0].command, custom);
  assert.equal(calls[0].options.shell, false);
});

test('py -3 compatibility uses separate argv rather than a shell command', async () => {
  const { runtime, calls } = harness({ pythonPath: 'py -3' });
  await runtime.status({});
  assert.equal(calls[0].command, 'py');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-3', '-B', '-c']);
});

test('managed environment is probed before system executables', async () => {
  const managed = process.platform === 'win32'
    ? join(home, '.dsh', 'state', 'dsh-video-study', 'venv', 'Scripts', 'python.exe')
    : join(home, '.dsh', 'state', 'dsh-video-study', 'venv', 'bin', 'python');
  const { runtime, calls } = harness({}, { dependencies: { accessImpl: async () => {} } });
  await runtime.status({});
  assert.equal(calls[0].command, managed);
});

test('missing Python returns dependency_missing and never installs anything', async () => {
  const { runtime, calls } = harness({}, { spawnError: 'ENOENT' });
  const result = await runtime.status({});
  assert.equal(result.status, 'dependency_missing');
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.args.includes('-c')), true);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('explicit missing Python does not silently switch interpreters', async () => {
  const { runtime, calls } = harness({ pythonPath: 'custom-python' }, { spawnError: 'ENOENT' });
  assert.equal((await runtime.status({})).status, 'dependency_missing');
  assert.equal(calls.length, 1);
});

test('invalid stdout is not exposed and cannot be treated as successful extraction', async () => {
  const { runtime } = harness({}, { rawStdout: `debug ${KEY} https://bad.invalid/?signature=SECRET` });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  assert.equal(result.status, 'runner_failed');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('nonzero runner exit cannot return a success marker', async () => {
  const { runtime } = harness({}, { response: { status: 'ok' }, exitCode: 1 });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'runner_failed');
});

test('network and permission errors pass through without retry or backend switch', async () => {
  for (const status of ['network_error', 'login_required', 'rate_limited', 'platform_restricted']) {
    const { runtime, requests } = harness({ mode: 'local' }, { response: { status, success: false } });
    assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, status);
    assert.equal(requests().length, 1);
    assert.equal(requests()[0].config.mode, 'local');
  }
});

test('pre-aborted tool calls never spawn', async () => {
  const controller = new AbortController(); controller.abort();
  const { runtime, calls } = harness();
  assert.equal((await runtime.status({}, { signal: controller.signal })).status, 'cancelled');
  assert.equal(calls.length, 0);
});

test('cancellation terminates child and waits for close rather than exposing partial output', async () => {
  const controller = new AbortController();
  const { runtime, calls } = harness({}, { hang: true, onRequest() { controller.abort(); } });
  const result = await runtime.status({}, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(calls[1].kills, ['SIGTERM']);
  assert.equal(result.success, false);
});

test('parent close does not finish cancellation before process-tree termination completes', async () => {
  const controller = new AbortController();
  let release;
  let killStarted;
  const started = new Promise(resolveDone => { killStarted = resolveDone; });
  const gate = new Promise(resolveDone => { release = resolveDone; });
  const { runtime } = harness({}, { hang: true, onRequest() { controller.abort(); },
    dependencies: { terminateImpl: async child => { child.kill('SIGTERM'); killStarted(); await gate; return true; } } });
  let settled = false;
  const pending = runtime.status({}, { signal: controller.signal }).then(result => { settled = true; return result; });
  await started;
  await new Promise(resolveDone => setImmediate(resolveDone));
  assert.equal(settled, false);
  release();
  assert.equal((await pending).status, 'cancelled');
});

test('hard process deadline covers a hung runner', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const { runtime, calls } = harness({}, { hang: true, dependencies: { timeoutScale: 0.0001 } });
    const result = await runtime.status({});
    assert.equal(result.status, 'timeout');
    assert.deepEqual(calls[1].kills, ['SIGTERM']);
  } finally { clearTimeout(keepAlive); }
});

test('unconfirmed child exit is an explicit failure, never a cleanup claim', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const { runtime, calls } = harness({}, { hang: true, neverExit: true, dependencies: { timeoutScale: 0.0001 } });
    const result = await runtime.status({});
    assert.equal(result.status, 'timeout');
    assert.equal(result.success, false);
    assert.equal(result.warnings.some(warning => warning.includes('退出未确认')), true);
    assert.equal(result.warnings.some(warning => warning.includes('finally')), true);
    assert.deepEqual(calls[1].kills, ['SIGTERM', 'SIGKILL']);
  } finally { clearTimeout(keepAlive); }
});

test('stdout size limit terminates process rather than leaking arbitrary child logs', async () => {
  const { runtime, calls } = harness({}, { rawStdout: 'x'.repeat(4 * 1024 * 1024 + 1) });
  const result = await runtime.status({});
  assert.equal(result.status, 'output_limit');
  assert.deepEqual(calls[1].kills, ['SIGTERM']);
});

test('dispose cancels every active Python operation', async () => {
  let entered;
  const pending = new Promise(resolveDone => { entered = resolveDone; });
  const { runtime } = harness({}, { hang: true, onRequest() { entered(); } });
  const work = runtime.status({});
  await pending;
  await runtime.dispose();
  assert.equal((await work).status, 'cancelled');
});

test('setup returns only an explicit manual command, never invokes setup script', async () => {
  const { runtime, calls } = harness({ mode: 'local', proxy: 'http://127.0.0.1:7897' });
  const result = await runtime.setup({ backend: 'local', model: 'tiny' });
  assert.equal(result.status, 'setup_command_prepared');
  assert.equal(result.executed, false);
  assert.match(result.command, /--allow-downloads/);
  assert.match(result.command, /setup_environment\.py/);
  assert.match(result.command, /--backend/);
  assert.match(result.command, /tiny/);
  assert.match(result.command, /http:\/\/127\.0\.0\.1:7897/);
  assert.equal(result.state_dir, join(home, '.dsh', 'state', 'dsh-video-study'));
  assert.equal(result.local_model_dir, join(result.state_dir, 'models', 'tiny'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-c'), true);
  assert.equal(result.command.includes(KEY), false);
});

test('setup never reads cloud credentials and refuses credentialed/socks proxy commands', async () => {
  assert.equal((await harness(unavailableCloudConfig()).runtime.setup({ backend: 'cloud' })).status, 'setup_command_prepared');
  for (const proxy of ['socks5://127.0.0.1:9', 'http://user:password@127.0.0.1:9', 'http://127.0.0.1:9/?secret=x']) {
    const { runtime } = harness({ proxy });
    const result = await runtime.setup({});
    assert.equal(result.status, 'invalid_config');
    assert.equal('command' in result, false);
  }
});

test('Windows tree termination uses fixed argv and no shell', async () => {
  const calls = [];
  const child = { pid: 42, kill() {} };
  await terminateProcessTree(child, 'win32', (command, args, options) => {
    calls.push({ command, args, options });
    const killer = new EventEmitter(); killer.kill = () => {};
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  });
  assert.equal(calls[0].command, 'taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', '42', '/T', '/F']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, 'ignore');
});

test('real process cancellation reaps the runner and its spawned descendant offline', { timeout: 15000 }, async t => {
  // Real OS processes, but a Node protocol fixture substitutes for Python. No
  // package setup, model, media, cloud call or temporary fixture file is needed.
  const controller = new AbortController();
  let runner;
  let descendantPid;
  const adapterSpawn = (command, args, spawnOptions) => {
    if (command === 'taskkill.exe') return realSpawn(command, args, spawnOptions);
    const probe = args.includes('-c');
    const code = probe
      ? `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({executable:process.execPath,version:[3,13]})))`
      : `const {spawn}=require('node:child_process'); process.stdin.resume(); process.stdin.on('end',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({descendantPid:child.pid})); setInterval(()=>{},1000);});`;
    const child = realSpawn(process.execPath, ['-e', code], spawnOptions);
    if (!probe) {
      runner = child;
      child.stdout.once('data', chunk => {
        descendantPid = JSON.parse(chunk.toString()).descendantPid;
        controller.abort();
      });
    }
    return child;
  };
  t.after(async () => {
    if (runner && runner.exitCode === null && runner.signalCode === null)
      await terminateProcessTree(runner, process.platform, realSpawn);
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
  });
  const runtime = createRuntime({}, { spawnImpl: adapterSpawn,
    accessImpl: async () => { throw new Error('no managed fixture'); } });
  const result = await runtime.status({}, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(Number.isInteger(descendantPid), true);
  assert.notEqual(runner.exitCode === null && runner.signalCode === null, true);
  assert.throws(() => process.kill(descendantPid, 0));
  assert.equal(result.warnings.some(warning => warning.includes('finally')), true);
});

test('registration exposes exactly three tools and no API key schema input', async () => {
  const registered = [];
  let dispose;
  let provider;
  const runtime = { status: async () => ({ status: 'test' }), extract: async () => ({ status: 'test' }),
    setup: async () => ({ status: 'test' }), dispose: async () => { dispose = true; } };
  const effects = [];
  const ctx = { tools: { register(tool) { registered.push(tool); } },
    effect(callback) { effects.push(callback()); },
    inject(names, callback) {
      if (names[0] === 'connection') { callback({}); return; }
      assert.deepEqual(names, ['skills']); callback({ skills: { registerProvider(getter) { provider = getter(); } } });
    } };
  applyPlugin(ctx, {}, { defineTool: value => value, runtimeFactory: () => runtime, rank: 600 });
  assert.deepEqual(registered.map(tool => tool.name), ['video_study_status', 'video_study_extract', 'video_study_setup']);
  assert.equal(registered.some(tool => JSON.stringify(tool.parameters).includes('ApiKey')), false);
  assert.equal((await provider.list())[0].name, 'video-study');
  assert.equal((await provider.list())[0].rank, 600);
  assert.equal((await registered[0].execute({}, {})).status, 'test');
  await effects[0]();
  assert.equal(dispose, true);
});

test('skill provider refers only to the package-relative skill, avoiding old global names', async () => {
  const provider = createSkillProvider();
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'video-study');
  assert.equal(candidate.provider, 'dsh-video-study');
  assert.equal(basename(candidate.resourceBase.path), 'video-study');
  assert.match(candidate.locator.pathname, /skills\/video-study\/SKILL\.md$/);
});

test('tool schema describes disabling-only captionsOnly and safe setup', () => {
  const definitions = createToolDefinitions({}, {});
  const extract = definitions[1];
  assert.equal('mode' in extract.parameters, false);
  assert.equal('cloudUploadConsent' in extract.parameters, false);
  assert.equal('out' in extract.parameters, false);
  assert.deepEqual(extract.parameters.language.enum, ['en', 'zh', 'auto']);
  assert.equal(definitions[2].name, 'video_study_setup');
  assert.equal(definitions[0].timeoutMs, 45000);
});

test('native SDK entry remains a thin import adapter, not a runtime installer', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /@deepseek-ai\/schemastery/);
  assert.match(source, /@deepseek-ai\/dsh-tools/);
  assert.match(source, /@deepseek-ai\/dsh-skill/);
  assert.match(source, /export const name = 'video-study'/);
  assert.equal(source.includes('npm install'), false);
});

test('sanitizer ignores prototype-shaped fields in untrusted runner data', () => {
  const result = sanitizeResult(JSON.parse('{"status":"ok","__proto__":{"polluted":true},"constructor":{"secret":"bad"}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal(Object.hasOwn(result, 'constructor'), false);
});

test('recursive sanitizer drops credential-shaped keys, keeps public Bilibili identity', () => {
  const result = sanitizeResult({ nested: { cloudApiKeyFile: 'private', signed_url: 'bad', value: KEY },
    source_url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&token=SECRET' }, [KEY]);
  assert.equal(result.nested.value, '[redacted]');
  assert.equal('cloudApiKeyFile' in result.nested, false);
  assert.equal(result.source_url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
});
