#!/usr/bin/env node
// Development probe only; not runtime-distributed. Reads SDK code from --archive.
// Never constructs SettingsForms (which imports legacy profile settings), edits a
// real profile, starts DSH/Python, installs, downloads, or accesses credentials.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Socket } from 'node:net';
import { openAsarSdk } from '../tests/support/asar-sdk.mjs';
import { createConfig } from '../lib/adapter.mjs';
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
    fiber: { uid: 1, state: 2, runtime: { Config }, config: Config(raw), ctx: {} } };
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
  const requests = [], calls = [];
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
  const dynamicConfig = new Proxy({}, { get(_target, key) { return entry.fiber.config[key]; } });
  runtime = createRuntime(dynamicConfig, { spawnImpl, accessImpl: async () => { throw new Error('fixture absent'); },
    homedirImpl: () => resolve('fixture-home'), tmpdirImpl: () => resolve('fixture-tmp'),
    uuidImpl: () => 'native-settings-fixture', platform: process.platform,
    terminateImpl: async child => { child.kill(); return true; } });
  check((await runtime.extract({ target: 'abcdefghijk' })).status === 'ok', 'runtime_initial_extract');
  check(requests[0].config.mode === 'captions' && !Object.hasOwn(requests[0].config, 'cloudApiKey'), 'runtime_captions_no_secret');
  const firstRevision = snapshot.revision;
  snapshot = await repository.save({ revision: snapshot.revision, patch: { mode: 'cloud',
    cloudEndpoint: 'https://asr.example.invalid/v1/audio/transcriptions', cloudModel: 'fixture-model', cloudUploadConsent: true },
    secret: { action: 'set', value: secretB } });
  check(snapshot.revision > firstRevision && snapshot.values.mode === 'cloud', 'repository_save_cloud_revision');
  check(entry.fiber.config.mode.get() === 'cloud' && entry.fiber.config.cloudApiKey.get() === secretB, 'native_refs_after_save');
  assertSecretFree(snapshot, 'repository_saved_secret_free');
  assertSecretFree(descriptor(), 'native_describe_after_save_secret_free');
  const result = await runtime.extract({ target: 'abcdefghijk', forceAsr: true });
  check(result.status === 'ok', 'same_runtime_cloud_extract');
  check(requests[1].config.mode === 'cloud' && requests[1].config.cloudApiKey === secretB, 'same_runtime_reads_new_secret');
  check(requests[1].config.cloudEndpoint === 'https://asr.example.invalid/v1/audio/transcriptions'
    && requests[1].config.cloudUploadConsent === true, 'same_runtime_reads_new_endpoint_consent');
  assertSecretFree(result, 'runtime_result_secret_free');
  check(calls.every(call => !JSON.stringify(call.args).includes(secretA) && !JSON.stringify(call.args).includes(secretB)), 'runtime_argv_secret_free');

  let before = JSON.stringify(raw), beforeEdits = edits;
  let conflict = false;
  try { await repository.save({ revision: firstRevision, patch: { mode: 'local' }, secret: { action: 'clear' } }); }
  catch (error) { conflict = error.code === 'settings_conflict'; }
  check(conflict && JSON.stringify(raw) === before && edits === beforeEdits, 'repository_stale_cas_preserves_config');
  let nativeConflict = false;
  try { await settings.mutate('video-fixture', [{ op: 'set', path: ['mode'], value: 'local' }], firstRevision); }
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
  snapshot = await repository.save({ revision: snapshot.revision, patch: { mode: 'local', localModel: 'tiny',
    localModelDir: resolve('fixture-model'), localDevice: 'cpu', localComputeType: 'int8' }, secret: { action: 'keep' } });
  check((await runtime.extract({ target: 'abcdefghijk', forceAsr: true })).status === 'ok', 'same_runtime_local_extract');
  check(requests[2].config.mode === 'local' && requests[2].config.localModel === 'tiny'
    && requests[2].config.localModelDir === resolve('fixture-model') && !Object.hasOwn(requests[2].config, 'cloudApiKey'), 'same_runtime_reads_local_config');
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
