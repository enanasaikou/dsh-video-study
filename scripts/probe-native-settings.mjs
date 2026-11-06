#!/usr/bin/env node
// Development probe only; not runtime-distributed. Reads SDK code from --archive.
// Never constructs SettingsForms (which imports legacy profile settings), edits a
// real profile, starts DSH/Python, installs, downloads, or accesses credentials.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Socket } from 'node:net';
import { openAsarSdk } from '../tests/support/asar-sdk.mjs';
import { createConfig, createToolDefinitions } from '../lib/adapter.mjs';
import { LIVE_FIELDS, configValue } from '../lib/config-values.mjs';
import { createRuntime } from '../lib/runtime.mjs';
import { createAsrSettingsRepository } from '../lib/asr-settings.mjs';

let stage = 'arguments', checks = 0, sdk, runtime;
const check = (condition, name) => { stage = name; if (!condition) throw new Error('probe assertion'); checks++; };
const oldConnect = Socket.prototype.connect, oldFetch = globalThis.fetch;
Socket.prototype.connect = function () { throw new Error('offline probe forbids network'); };
globalThis.fetch = async () => { throw new Error('offline probe forbids fetch'); };
try {
  const { values } = parseArgs({ options: { archive: { type: 'string' } }, allowPositionals: false });
  if (!values.archive) throw new Error('archive required');
  stage = 'sdk_load';
  sdk = openAsarSdk(values.archive);
  const [{ default: z }, { SettingsForms, SettingsConflictError }] = await Promise.all([
    sdk.importPackage('@deepseek-ai/schemastery'), sdk.importPackage('@deepseek-ai/dsh-settings'),
  ]);
  const versions = { schemastery: sdk.packageVersion('@deepseek-ai/schemastery'),
    settings: sdk.packageVersion('@deepseek-ai/dsh-settings') };
  stage = 'native_schema';
  stage = 'create_config';
  const Config = createConfig(z);
  stage = 'schema_to_json';
  const schema = Config; // native toJSON() is a uid/refs graph, not a dict tree
  const secretA = 'FAKE_NATIVE_KEY_A_NOT_A_REAL_CREDENTIAL', secretB = 'FAKE_NATIVE_KEY_B_NOT_A_REAL_CREDENTIAL';
  for (const name of LIVE_FIELDS) check(schema.dict[name]?.meta?.volatile === true, 'schema_volatile_' + name);
  check(schema.dict.cloudApiKey.meta.role === 'secret', 'native_secret_role');
  check(!schema.dict.registerSkill.meta.volatile, 'native_nonvolatile_registration');
  let raw = { mode: 'captions', cloudApiKey: secretA, registerSkill: true,
    pythonPath: resolve('fixture-python.exe'), stateDir: resolve('fixture-state'), outputDir: resolve('fixture-output') };
  const entry = { id: 'fixture', options: { id: 'video-fixture', config: raw },
    fiber: { uid: 1, state: 2, runtime: { Config }, config: Config(raw), get effectiveConfig() { return this.config; }, ctx: {} } };
  check(typeof entry.fiber.config.mode?.get === 'function', 'native_ref_get_abi');
  check(entry.fiber.config.mode.get() === 'captions', 'native_ref_initial_mode');
  check(entry.fiber.config.cloudApiKey.get() === secretA, 'native_ref_secret_value');
  let edits = 0;
  const editor = {
    configuration: () => [{ entry, inherited: {}, override: raw }],
    entries: () => [entry],
    async edit(target, transform) {
      check(target === entry, 'editor_only_own_entry');
      const next = transform(raw, {});
      // Reparse only this in-memory fixture. Real Loader commits refs in place;
      // this proxy below follows fiber.config to model the same next-call view.
      const parsed = Config(next);
      raw = next; entry.options.config = raw; entry.fiber.config = parsed; edits++;
    },
  };
  const settings = Object.create(SettingsForms.prototype);
  settings.ownerContext = { configEditor: editor, emit() {} };
  settings.revisions = new Map(); settings.presentations = new Map();
  const descriptor = () => settings.describe({ redactSecrets: true })[0];
  function assertSecretFree(value, name) {
    const serialized = JSON.stringify(value);
    check(!serialized.includes(secretA) && !serialized.includes(secretB), name);
  }
  stage = 'native_describe';
  let row = descriptor();
  check(row.ns === 'video-fixture' && row.applies === 'live', 'native_namespace_live');
  check(!Object.hasOwn(row.value, 'registerSkill') && !Object.hasOwn(row.user, 'registerSkill'), 'native_projects_volatile_only');
  check(Object.keys(new z(row.schema).dict).length === LIVE_FIELDS.length, 'native_form_field_count');
  check(!Object.hasOwn(row.value, 'cloudApiKey') && !Object.hasOwn(row.user, 'cloudApiKey'), 'native_secret_removed');
  check(row.secrets.some(item => item.path.join('.') === 'cloudApiKey' && item.set), 'native_secret_sidecar');
  assertSecretFree(row, 'native_describe_secret_free');
  const repository = createAsrSettingsRepository({ settings, configEditor: editor, fiber: entry.fiber }, {
    hasSecret: () => configValue(entry.fiber.config.cloudApiKey).length > 0,
  });
  let snapshot = await repository.read();
  check(snapshot.values.mode === 'captions' && snapshot.secretConfigured, 'repository_initial_snapshot');
  assertSecretFree(snapshot, 'repository_initial_secret_free');

  stage = 'runtime_fixture';
  const requests = [], calls = [], scratches = [];
  const fixtureWorkspace = resolve('fixture-workspace');
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    let input = ''; child.stdin.on('data', data => { input += data; });
    calls.push({ command, args, options });
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin.once('finish', () => queueMicrotask(() => {
      if (args.includes('-c')) child.stdout.write(JSON.stringify({ executable: resolve('fixture-python.exe'), version: [3, 13] }));
      else {
        requests.push(JSON.parse(input));
        // Deliberately echo a fake key into an ordinary result field, not stdout.
        child.stdout.write(JSON.stringify({ status: 'ok', note: 'safe fixture ' + secretB }));
      }
      child.emit('close', 0);
    }));
    return child;
  };
  let configReads = 0;
  const dynamicConfig = new Proxy({}, { get(_target, key) { configReads++; return entry.fiber.config[key]; } });
  runtime = createRuntime(dynamicConfig, { spawnImpl, accessImpl: async () => { throw new Error('fixture absent'); },
    getWorkspace: async () => fixtureWorkspace,
    createScratchImpl: async base => {
      const scratch = { base, path: join(base, '.fixture-scratch-' + (scratches.length + 1)), disposed: false };
      scratches.push(scratch);
      return { path: scratch.path, dispose: async () => { scratch.disposed = true; } };
    },
    homedirImpl: () => { throw new Error('home fallback forbidden'); },
    tmpdirImpl: () => { throw new Error('global temp fallback forbidden'); },
    uuidImpl: () => 'native-settings-fixture', platform: process.platform,
    terminateImpl: async child => { child.kill(); return true; } });
  const extractTool = createToolDefinitions({}, runtime)[1];
  check(extractTool.parameters.outputStyle?.required === true
    && JSON.stringify(extractTool.parameters.outputStyle.enum) === JSON.stringify(['verbatim', 'concise', 'summary']), 'required_per_call_output_style_schema');
  const beforeGateReads = configReads;
  const gate = await runtime.extract({ target: 'abcdefghijk' });
  check(gate.status === 'output_style_required' && gate.success === false && gate.choices.length === 3
    && configReads === beforeGateReads && calls.length === 0 && scratches.length === 0, 'native_missing_style_before_config_and_spawn');
  const initialResult = await runtime.extract({ outputStyle: 'verbatim', target: 'abcdefghijk' });
  check(initialResult.status === 'ok' && initialResult.output_style === 'verbatim', 'runtime_initial_extract');
  check(requests[0].config.mode === 'captions' && !Object.hasOwn(requests[0].config, 'cloudApiKey'), 'runtime_captions_no_secret');
  const firstRevision = snapshot.revision;
  snapshot = await repository.save({ revision: snapshot.revision, patch: { mode: 'cloud',
    cloudEndpoint: 'https://asr.example.invalid/v1/audio/transcriptions', cloudModel: 'fixture-model', cloudUploadConsent: true },
    secret: { action: 'set', value: secretB } });
  check(snapshot.revision > firstRevision && snapshot.values.mode === 'cloud', 'repository_save_cloud_revision');
  check(entry.fiber.config.mode.get() === 'cloud' && entry.fiber.config.cloudApiKey.get() === secretB, 'native_refs_after_save');
  assertSecretFree(snapshot, 'repository_saved_secret_free');
  assertSecretFree(descriptor(), 'native_describe_after_save_secret_free');
  const result = await runtime.extract({ outputStyle: 'concise', target: 'abcdefghijk', forceAsr: true });
  check(result.status === 'ok' && result.output_style === 'concise' && result.output_style_label === '简要压缩', 'same_runtime_cloud_extract');
  check(requests[1].config.mode === 'cloud' && requests[1].config.cloudApiKey === secretB, 'same_runtime_reads_new_secret');
  check(requests[1].config.cloudEndpoint === 'https://asr.example.invalid/v1/audio/transcriptions'
    && requests[1].config.cloudUploadConsent === true, 'same_runtime_reads_new_endpoint_consent');
  assertSecretFree(result, 'runtime_result_secret_free');
  check(calls.every(call => !JSON.stringify(call.args).includes(secretA) && !JSON.stringify(call.args).includes(secretB)), 'runtime_argv_secret_free');

  let before = JSON.stringify(raw), beforeEdits = edits;
  let conflict = false;
  try { await repository.save({ revision: firstRevision, patch: { mode: 'captions' }, secret: { action: 'clear' } }); }
  catch (error) { conflict = error.code === 'settings_conflict'; }
  check(conflict && JSON.stringify(raw) === before && edits === beforeEdits, 'repository_stale_cas_preserves_config');
  let nativeConflict = false;
  try { await settings.mutate('video-fixture', [{ op: 'set', path: ['mode'], value: 'captions' }], firstRevision); }
  catch (error) { nativeConflict = error instanceof SettingsConflictError; }
  check(nativeConflict && JSON.stringify(raw) === before, 'native_stale_cas_preserves_config');
  let rejected = false;
  try { await settings.mutate('video-fixture', [{ op: 'set', path: ['registerSkill'], value: false }], snapshot.revision); }
  catch { rejected = true; }
  check(rejected && JSON.stringify(raw) === before, 'native_nonvolatile_mutation_rejected');
  snapshot = await repository.save({ revision: snapshot.revision, patch: {}, secret: { action: 'keep' } });
  check(entry.fiber.config.cloudApiKey.get() === secretB && edits === beforeEdits, 'secret_keep_no_edit');
  snapshot = await repository.save({ revision: snapshot.revision, patch: {}, secret: { action: 'clear' } });
  check(raw.cloudApiKey === '' && entry.fiber.config.cloudApiKey.get() === '' && !snapshot.secretConfigured, 'secret_clear_stores_empty');
  assertSecretFree(descriptor(), 'native_describe_after_clear_secret_free');
  before = JSON.stringify(raw); beforeEdits = edits;
  for (const patch of [{ mode: 'local' }, { localModel: 'tiny' }, { localModelDir: resolve('fixture-model') },
    { localDevice: 'cpu' }, { localComputeType: 'int8' }]) {
    let rejected = false;
    try { await repository.save({ revision: snapshot.revision, patch }); }
    catch (error) { rejected = error.code === 'invalid_input'; }
    check(rejected && JSON.stringify(raw) === before && edits === beforeEdits,
      'removed_local_setting_rejected_' + Object.keys(patch)[0]);
  }
  snapshot = await repository.save({ revision: snapshot.revision, patch: { mode: 'captions' }, secret: { action: 'keep' } });
  const finalResult = await runtime.extract({ outputStyle: 'summary', target: 'abcdefghijk' });
  check(finalResult.status === 'ok' && finalResult.output_style === 'summary' && finalResult.output_style_label === '总结', 'same_runtime_returns_to_captions');
  const callsBeforeNewChoice = calls.length;
  check((await runtime.extract({ target: 'abcdefghijk' })).status === 'output_style_required'
    && calls.length === callsBeforeNewChoice, 'native_previous_choice_not_reused');
  check(requests.every(request => !Object.hasOwn(request, 'outputStyle') && !Object.hasOwn(request, 'output_style')),
    'output_style_does_not_change_python_request');
  check(requests[2].config.mode === 'captions' && !Object.hasOwn(requests[2].config, 'cloudApiKey'), 'captions_after_cloud_does_not_read_key');
  for (const field of ['localModel', 'localModelDir', 'localDevice', 'localComputeType'])
    check(!Object.hasOwn(schema.dict, field) && !Object.hasOwn(snapshot.values, field)
      && requests.every(request => !Object.hasOwn(request.config, field)), 'removed_field_absent_' + field);
  for (const args of [{ backend: 'local' }, { model: 'small' }, { backend: 'cloud', model: 'tiny' }]) {
    const beforeCalls = calls.length;
    check((await runtime.setup(args)).status === 'invalid_input' && calls.length === beforeCalls,
      'removed_setup_argument_rejected_' + Object.keys(args).join('_'));
  }
  check(scratches.length === requests.length && scratches.every(scratch => scratch.disposed), 'fake_request_scratch_disposed');
  check(calls.every(call => call.options.cwd === fixtureWorkspace), 'workspace_cwd_for_probes_and_runner');
  for (let index = 0; index < scratches.length; index++) {
    const scratch = scratches[index];
    check(scratch.base === raw.outputDir, 'explicit_output_base_' + index);
    check(calls.slice(index * 2, index * 2 + 2).every(call => ['TMP', 'TEMP', 'TMPDIR'].every(key => call.options.env[key] === scratch.path)),
      'isolated_temp_for_probe_and_runner_' + index);
  }
  console.log(JSON.stringify({ status: 'passed', checks, sdk: versions, volatileFields: LIVE_FIELDS.length,
    mockedRunnerRequests: requests.length, networkUsed: false, profileWritten: false,
    scope: 'Actual ASAR Schema/SettingsForms; in-memory ConfigEditor; same-runtime JSON stdin with fake spawn',
    notVerified: ['real profile persistence', 'real Loader in-place commit or HMR', 'browser rendering', 'Python or actual ASR'] }));
} catch {
  console.log(JSON.stringify({ status: 'failed', stage, checks, networkUsed: false, profileWritten: false,
    note: 'Raw exceptions/configuration are intentionally not printed.' }));
  process.exitCode = 1;
} finally {
  await runtime?.dispose(); sdk?.close(); Socket.prototype.connect = oldConnect; globalThis.fetch = oldFetch;
}
