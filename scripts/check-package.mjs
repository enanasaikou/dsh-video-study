import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildClient } from '../client/build.mjs';
import { createToolDefinitions } from '../lib/adapter.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = filename => JSON.parse(readFileSync(join(root, filename), 'utf8'));
const pkg = json('package.json');
assert.equal(pkg.name, 'dsh-video-study');
assert.equal(pkg.version, '0.8.1');
assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-host-directory-picker']);
assert.equal(pkg.type, 'module');
assert.equal(pkg.main, 'lib/index.js');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.exports['./client'], './lib/client.js');
assert.equal(pkg.dsh.client.platform, 'web');
assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-general']);
assert.equal(readFileSync(join(root, 'lib/client.js'), 'utf8'), await buildClient({ write: false }),
  'Prebuilt native settings client must match pinned sources');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly'])
  assert.equal(pkg.scripts[hook], undefined, `Unexpected automatic lifecycle: ${hook}`);
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id: video-study/);
assert.match(patch, /name: dsh-video-study/);
assert.match(patch, /mode: captions/);
assert.match(patch, /cloudUploadConsent: false/);
const records = [];
function inspect(filename) {
  const absolute = join(root, filename), stat = lstatSync(absolute);
  assert.equal(stat.isSymbolicLink(), false, 'No symlinks in portable payload');
  assert.equal(/(?:^|[/\\])(?:node_modules|__pycache__|\.venv|\.git)(?:[/\\]|$)|\.pyc$|\.env$/i.test(filename), false,
    'Private/generated dependency or state payload: ' + filename);
  if (stat.isDirectory()) {
    for (const child of readdirSync(absolute)) inspect(join(filename, child));
    return;
  }
  const data = readFileSync(absolute), text = data.toString('utf8');
  assert.equal(/C:[/\\]Users[/\\]enana|D:[/\\]project[/\\]youtube-study-notes|app\.asar[/\\]dsh/i.test(text), false,
    'Machine-specific path leaked into runtime payload: ' + filename);
  records.push({ path: filename.replaceAll('\\', '/'), bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex') });
}
inspect('package.json');
for (const include of pkg.files) inspect(include);
assert.equal(new Set(records.map(item => item.path)).size, records.length);
assert.ok(records.some(item => item.path === 'skills/video-study/SKILL.md'));
assert.ok(records.some(item => item.path === 'python/cloud_asr.py'));
assert.ok(records.some(item => item.path === 'python/aliyun_asr.py'));
assert.ok(records.some(item => item.path === 'python/qwen_asr.py'));
assert.ok(records.some(item => item.path === 'python/volcengine_asr.py'));
assert.ok(records.some(item => item.path === 'python/tencent_asr.py'));
assert.ok(records.some(item => item.path === 'python/audio_prepare.py'));
assert.ok(records.some(item => item.path === 'python/cloud_output.py'));
assert.equal(records.some(item => /(?:local_asr|requirements-local)/.test(item.path)), false,
  'Cloud distribution must not ship local ASR engines or requirements');
assert.ok(records.some(item => item.path === 'lib/local-path-picker.mjs'));
assert.ok(records.some(item => item.path === 'python/document_export.py'));
assert.ok(records.some(item => item.path === 'python/requirements-document.txt'));
const skill = readFileSync(join(root, 'skills/video-study/SKILL.md'), 'utf8');
assert.match(skill, /name: video-study/);
assert.match(skill, /备注只保留必要的“识别字幕” → “改正字幕”/);
assert.match(skill, /默认最终只交付一个文件/);
assert.match(skill, /当前工作区或显式任务目录内的本次独占临时子目录/);
assert.match(skill, /ask_user_question/);
for (const label of ['原文（完全复述）', '简要压缩', '总结']) assert.ok(skill.includes(label));
const styleParameter = createToolDefinitions({}, {}).find(tool => tool.name === 'video_study_extract').parameters.outputStyle;
assert.equal(styleParameter.required, true);
assert.deepEqual(styleParameter.enum, ['verbatim', 'concise', 'summary']);
assert.ok(records.some(item => item.path === 'lib/workspace-paths.mjs'));
assert.match(readFileSync(join(root, 'python/requirements.txt'), 'utf8'), /yt-dlp==2026\.8\.19/);
assert.match(readFileSync(join(root, 'python/setup_environment.py'), 'utf8'), /python-docx==1\.2\.0/,'One-click install must include the Word export dependency');
const clientBundle = readFileSync(join(root, 'lib/client.js'), 'utf8');
assert.match(clientBundle, /一键准备运行环境/);
assert.match(clientBundle, /setup-install-status/);
for (const record of records.filter(item => /\.(?:py|mjs|js|txt)$/.test(item.path))) {
  assert.doesNotMatch(readFileSync(join(root, record.path), 'utf8'), /faster[_-]whisper|ctranslate2|WhisperModel|huggingface_hub/,
    'Local ASR inference/download code in cloud payload: ' + record.path);
}
const client = readFileSync(join(root, 'lib/client.js'), 'utf8');
assert.doesNotMatch(client, /快捷填入|选择预设或自定义|本机ASR|localModelDir|presets/);
assert.doesNotMatch(client, /服务名称、完整URL和模型均可自定义|服务只返回正文时保存无时间戳|切换目标\/协议\/凭据标识/);
const result = { status: 'passed', name: pkg.name, version: pkg.version, runtimeFiles: records.length,
  bytes: records.reduce((sum, item) => sum + item.bytes, 0),
  noLifecycleDownloads: true, noBundledModelsOrCredentials: true, records };
const index = process.argv.indexOf('--report');
if (index >= 0) {
  const destination = process.argv[index + 1];
  if (!destination || resolve(destination) !== destination) throw new Error('Report must be absolute');
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ ...result, records: undefined }, null, 2));
