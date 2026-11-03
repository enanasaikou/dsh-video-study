import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createScratchDirectory } from './workspace-paths.mjs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { liveConfig } from './config-values.mjs';

export const MODES = ['captions', 'cloud'];
export const OUTPUT_STYLES = Object.freeze(['verbatim', 'concise', 'summary']);
const OUTPUT_STYLE_LABELS = Object.freeze({ verbatim: '原文（完全复述）', concise: '简要压缩', summary: '总结' });
const OUTPUT_STYLE_INSTRUCTIONS = Object.freeze({
  verbatim: '按课程原顺序完整复述，保留例子、假设与推导；仅订正明确识别错误，不压缩成提纲。',
  concise: '去掉重复和冗余表述，保留课程主线、关键公式、条件与代表性例子；标明简要压缩，不冒充逐句复述。',
  summary: '只整理主要结论、概念和关键公式，明确标为总结，不冒充完整复述。',
});
export const REASONS = ['no_captions', 'language_unavailable', 'unreliable_captions', 'user_requested'];
export const DEFAULTS = Object.freeze({ mode: 'captions', defaultLanguage: 'auto',
  cloudUploadConsent: false, allowInsecureLoopback: false,
  cloudMaxAudioMiB: 25, downloadTimeout: 300, asrTimeout: 3600, maxDuration: 14400,
  registerSkill: true });
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
// 设置页没有会话上下文：记住本进程最近一次解析出的状态目录作为无会话默认。
const PROBE_CODE = 'import json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:2])}))';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

class SafeError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const budgetNumber = (value, fallback, max) => typeof value === 'number'
  && Number.isFinite(value) && value > 0 && value <= max ? value : fallback;

/** 只用于排时间预算，不校验后端配置：invalid ASR 设置不能挡住已有字幕，
 * 真正的校验留在 Python 侧、只在确实走 ASR 时进行。 */
export function extractionBudgetMs(config = {}, marginSeconds = 120) {
  config = liveConfig(config);
  if ((config.mode ?? 'captions') === 'captions') return (300 + marginSeconds) * 1000;
  const download = budgetNumber(config.downloadTimeout, 300, 3600);
  const asr = budgetNumber(config.asrTimeout, 3600, 86400);
  return Math.ceil((download + 2 * asr + marginSeconds) * 1000);
}
const text = (value, fallback = '') => {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.includes('\0') || result.length > 32768)
    throw new SafeError('invalid_config', '配置字段必须是有限文本。');
  return result;
};
function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return '[redacted URL]';
    const host = url.hostname.toLowerCase();
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
      const id = url.searchParams.get('v');
      if (url.pathname === '/watch' && /^[\w-]{11}$/.test(id ?? ''))
        return `https://www.youtube.com/watch?v=${id}`;
    }
    if (['bilibili.com', 'www.bilibili.com'].includes(host)) {
      const match = url.pathname.match(/^\/video\/(BV[\da-zA-Z]{10})\/?$/);
      const page = url.searchParams.get('p');
      if (match) return `https://www.bilibili.com/video/${match[1]}${/^\d+$/.test(page ?? '') ? `?p=${page}` : ''}`;
    }
  } catch { /* 外部文本里可能有任意 URL */ }
  return '[redacted URL]';
}
export function sanitizeResult(value, secrets = [], depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    let result = value.slice(0, 65536);
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result.replace(/https?:\/\/[^\s<>"']+/gi, publicUrl);
  }
  if (Array.isArray(value)) return value.slice(0, 10000).map(item => sanitizeResult(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 1000)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)
          || /(?:api.?key|authorization|cookie|sessdata|secret|signature|signed.?url|access.?token|refresh.?token|qr.?url|qr.?key|flow.?id)/i.test(key)) continue;
      result[key] = sanitizeResult(item, secrets, depth + 1);
    }
    return result;
  }
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

/** 结束进程树：固定 argv、不用 shell、不接受外部输入。 */
export async function terminateProcessTree(child, platform = process.platform, spawnImpl = spawn) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) { try { child.kill('SIGTERM'); } catch {} return; }
  if (platform === 'win32') {
    const treeStopped = await new Promise(resolveDone => {
      let killer;
      let timer;
      const done = confirmed => { clearTimeout(timer); resolveDone(confirmed); };
      try {
        killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => done(false));
        killer.once('close', code => done(code === 0));
        timer = setTimeout(() => { try { killer.kill(); } catch {} done(false); }, 1500);
        timer.unref?.();
      } catch { done(false); }
    });
    if (treeStopped) return true;
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
      // 父进程退出不代表后代停下；同一个进程组再补一次 SIGKILL。
      await new Promise(resolveDone => setTimeout(resolveDone, 300));
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
      return true;
    } catch { /* 子进程可能已经退出 */ }
  }
  try { child.kill('SIGTERM'); } catch {}
  return false;
}

function isBilibiliTarget(target) {
  const value = target.trim();
  if (/^BV[\da-zA-Z]{10}$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['bilibili.com', 'www.bilibili.com'].includes(url.hostname.toLowerCase())
      && /^\/video\/BV[\da-zA-Z]{10}\/?$/.test(url.pathname);
  } catch { return false; }
}

export function createRuntime(rawConfig = {}, dependencies = {}) {
  rawConfig = liveConfig(rawConfig);
  const deps = { spawnImpl: spawn, accessImpl: access,
    getWorkspace: async () => null, createScratchImpl: createScratchDirectory,
    uuidImpl: randomUUID, platform: process.platform, root: packageRoot, homedirImpl: homedir,
    terminateImpl: terminateProcessTree, timeoutScale: 1, ...dependencies };
  const active = new Set();
  const workspaceRequired = () => new SafeError('workspace_required', '无法确定当前会话工作区；请在会话中调用，或在设置中明确填写对应的绝对目录。');
  function absoluteDirectory(value, field) {
    if (typeof value !== 'string' || !value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
        || /^[\\/]{2}/.test(value) || value.split(/[\\/]/).includes('..'))
      throw new SafeError('invalid_config', `${field} 必须为本机绝对目录。`);
    return resolve(value);
  }
  async function workspaceFor(execution, optional = false) {
    if (execution.signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
    try {
      const value = await deps.getWorkspace(execution);
      if (execution.signal?.aborted) throw new SafeError('cancelled');
      return value == null ? null : absoluteDirectory(value, '工作区');
    } catch {
      if (execution.signal?.aborted) throw new SafeError('cancelled');
      // A saved explicit base does not depend on a vanished session project.
      // Only ignore workspace resolution, never output validation/write errors.
      if (optional) return null;
      throw workspaceRequired();
    }
  }
  // 运行环境属于宿主安装，不属于任务产物：设置页没有会话时也必须能装。
  // 位置固定在用户目录下的托管目录，这样设置页装的解释器，会话里也一定用得到。
  const defaultStateDir = () => join(deps.homedirImpl(), '.dsh', 'state', 'dsh-video-study');
  function taskDirectory(explicit, workspace, leaf) {
    if (explicit) return absoluteDirectory(explicit, '输出目录');
    if (!workspace) throw workspaceRequired();
    return join(workspace, 'video-study', leaf);
  }
  async function taskScratch(base) {
    try { return await deps.createScratchImpl(base); }
    catch { throw new SafeError('workspace_unavailable', '任务目录不可写或包含链接；未回退到系统临时目录，请检查工作区权限或显式目录。'); }
  }
  async function finishScratch(scratch, retained, result) {
    if (!scratch) return;
    if (retained) {
      if (result) result.warnings = [...(result.warnings ?? []), '进程终止未确认；已保留本次临时目录，未删除仍可能使用的文件。'];
      return;
    }
    try { await scratch.dispose(); }
    catch { if (result) result.warnings = [...(result.warnings ?? []), '本次临时目录未能清理；未删除其他资料。']; }
  }
  // undefined 才取默认值：null/非法值原样交给 Python，由它在真正走 ASR 时拒绝。
  const take = (key, fallback = DEFAULTS[key] ?? '') => {
    const value = rawConfig[key]; return value === undefined ? fallback : value;
  };
  const stateDir = (strict = true, view = rawConfig, workspace = null) => {
    const value = view.stateDir;
    if (value === undefined || value === '') return defaultStateDir();
    if (typeof value !== 'string' || value.includes('\0') || value.length > 32768 || !isAbsolute(value)) {
      if (strict) throw new SafeError('invalid_config', 'stateDir 必须为绝对路径。');
      return null; // 非法的 ASR 配置不能挡住只用系统 Python 的字幕提取
    }
    return value;
  };
  const configuredMode = () => {
    const mode = rawConfig.mode ?? DEFAULTS.mode;
    if (!MODES.includes(mode)) throw new SafeError('invalid_config', '云端发行版仅支持 captions 或 cloud 模式。');
    return mode;
  };
  // 不 spread rawConfig：仅字幕模式不能碰到云端密钥或后端字段。
  function pythonConfig(mode) {
    const config = { mode, proxy: text(rawConfig.proxy),
      youtubeCookieFile: text(rawConfig.youtubeCookieFile), biliCookieFile: text(rawConfig.biliCookieFile) };
    if (mode === 'captions') return config;
    for (const key of ['downloadTimeout', 'asrTimeout', 'maxDuration']) config[key] = take(key);
    if (mode === 'cloud') {
      for (const key of ['cloudProviderName', 'cloudProtocol', 'cloudResponseFormat', 'cloudAppId', 'cloudRegion', 'cloudResourceId',
        'cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudModel',
        'cloudUploadConsent', 'allowInsecureLoopback', 'cloudMaxAudioMiB']) config[key] = take(key);
    }
    return config;
  }

  /** stdout 有上限；stderr 只取显式进度行（DSH_STEP  前缀），其它内容一律丢弃。 */
  function runProcess(command, args, { request, timeoutMs, signal, cwd, tempDir, onProgress } = {}) {
    let child, finish, stop, cancelEntry;
    const finished = new Promise(resolveDone => {
      let settled = false, bytes = 0, chunks = [], interruption;
      let timer, escalation, watchdog;
      let termination = Promise.resolve(true);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(escalation); clearTimeout(watchdog);
        signal?.removeEventListener('abort', abort);
        if (cancelEntry) active.delete(cancelEntry);
      };
      finish = result => { if (!settled) { settled = true; cleanup(); resolveDone(result); } };
      stop = code => {
        if (settled || interruption) return;
        interruption = code;
        chunks = [];
        termination = Promise.resolve().then(() => deps.terminateImpl(child, deps.platform, deps.spawnImpl)).catch(() => false);
        escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000 * deps.timeoutScale);
        watchdog = setTimeout(() => finish({ error: code, processStopped: false }), 5000 * deps.timeoutScale);
        escalation.unref?.(); watchdog.unref?.();
      };
      const abort = () => stop('cancelled');
      if (signal?.aborted) { finish({ error: 'cancelled', processStopped: true }); return; }
      try {
        child = deps.spawnImpl(command, args, { shell: false, windowsHide: true,
          detached: deps.platform !== 'win32', stdio: ['pipe', 'pipe', onProgress ? 'pipe' : 'ignore'],
          ...(cwd ? { cwd } : {}),
          ...(tempDir ? { env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
            PYTHONDONTWRITEBYTECODE: '1' } } : {}) });
      } catch (error) { finish({ error: error?.code === 'ENOENT' ? 'dependency_missing' : 'runner_failed' }); return; }
      child.once('error', error => finish({ error: interruption ?? (error?.code === 'ENOENT' ? 'dependency_missing' : 'runner_failed') }));
      child.stdout.on('data', chunk => {
        if (settled || interruption) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_STDOUT_BYTES) { stop('output_limit'); return; }
        chunks.push(Buffer.from(chunk));
      });
      if (onProgress && child.stderr) {
        let buffered = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => {
          if (settled || interruption) return;
          buffered += chunk;
          let index;
          while ((index = buffered.indexOf(String.fromCharCode(10))) >= 0) {
            const line = buffered.slice(0, index).trim();
            buffered = buffered.slice(index + 1);
            if (line.startsWith('DSH_STEP ')) { try { onProgress(line.slice(9).slice(0, 200)); } catch { } }
          }
          if (buffered.length > 4096) buffered = '';
        });
      }
      child.stdin.on('error', () => stop('runner_failed'));
      child.once('close', code => {
        if (interruption) {
          void termination.then(confirmed => finish({ error: interruption, processStopped: true,
            processTreeStopped: confirmed !== false }));
        } else finish({ exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') });
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), (timeoutMs ?? 15000) * deps.timeoutScale);
      timer.unref?.();
      // argv 里永远没有密钥、endpoint、target 或 Cookie 路径。
      try { child.stdin.end(request === undefined ? '' : JSON.stringify(request)); }
      catch { stop('runner_failed'); }
    });
    cancelEntry = { cancel() { stop?.('cancelled'); return finished; } };
    if (child) { // 同步 spawn 失败时 finished 已经完成，不能再挂进 active
      active.add(cancelEntry);
      void finished.then(() => active.delete(cancelEntry));
    }
    return finished;
  }

  async function discoverPython(signal, forSetup = false, view = rawConfig, context = {}) {
    const explicit = text(view.pythonPath);
    let candidates = [];
    if (explicit) candidates.push(explicit === 'py -3' ? { command: 'py', prefix: ['-3'] } : { command: explicit, prefix: [] });
    else {
      if (!forSetup) {
        let managedState;
        try { managedState = stateDir(false, view, context.workspace); } catch { managedState = null; }
        if (managedState) {
          const managed = deps.platform === 'win32' ? join(managedState, 'venv', 'Scripts', 'python.exe') : join(managedState, 'venv', 'bin', 'python');
          try { await deps.accessImpl(managed); candidates.push({ command: managed, prefix: [] }); } catch {}
        }
      }
      candidates.push(...(deps.platform === 'win32'
        ? [{ command: 'python', prefix: [] }, { command: 'py', prefix: ['-3'] }, { command: 'python3', prefix: [] }]
        : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }, { command: 'py', prefix: ['-3'] }]));
    }
    for (const candidate of candidates) {
      const result = await runProcess(candidate.command, [...candidate.prefix, '-B', '-c', PROBE_CODE], { timeoutMs: 5000, signal, cwd: context.workspace, tempDir: context.tempDir });
      if (result.processStopped === false || result.processTreeStopped === false) {
        context.retained = true;
        throw new SafeError(result.error || 'runner_failed', 'Python 探测进程终止未确认；保留本次临时目录。');
      }
      if (result.error === 'cancelled') throw new SafeError('cancelled');
      if (!result.error && result.exitCode === 0) {
        try {
          const probe = JSON.parse(result.stdout);
          if (probe.version[0] === 3 && probe.version[1] >= 10 && isAbsolute(probe.executable))
            return { command: probe.executable, prefix: [] };
        } catch {}
      }
      if (explicit) break;
    }
    throw new SafeError('dependency_missing', '未找到 Python 3.10+，请配置 pythonPath 或自行准备环境。');
  }

  /** 凭据只从登录服务取，带超时与取消，失败信息不外露。 */
  async function getBiliCredential(signal) {
    if (signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
    const unavailable = new SafeError('login_required', 'B站登录存储暂不可用，请在设置中检查登录。');
    return new Promise((resolveDone, reject) => {
      let settled = false, timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolveDone(value);
      };
      const abort = () => finish(new SafeError('cancelled', '操作已取消。'));
      timer = setTimeout(() => finish(unavailable), deps.authTimeoutMs ?? 15000);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => deps.getBiliCredential()).then(value => finish(null, value),
        () => finish(unavailable));
    });
  }

  async function invoke(operation, args = {}, execution = {}) {
    let secrets = [], usedBiliSession, scratch, retained = false, response, context, outputStyle;
    try {
      if (execution.signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
      const allowed = operation === 'status' ? [] : ['target', 'language', 'forceAsr', 'reason', 'captionsOnly', 'outputStyle'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new SafeError('invalid_input', '工具参数不能修改后端、凭据或输出路径。');
      if (operation === 'extract') {
        outputStyle = args.outputStyle;
        if (outputStyle === undefined) return (response = {
          status: 'output_style_required', success: false, question: '本次转写以什么简略度输出？',
          choices: OUTPUT_STYLES.map(value => ({ value, label: OUTPUT_STYLE_LABELS[value] })),
          message: '请先通过提问工具让用户选择本次输出详略，再携带 outputStyle 重试；未开始提取或ASR。',
        });
        if (!OUTPUT_STYLES.includes(outputStyle)) throw new SafeError('invalid_input', '请选择原文（完全复述）、简要压缩或总结。');
      }
      const selected = configuredMode();
      if (args.captionsOnly !== undefined && typeof args.captionsOnly !== 'boolean') throw new SafeError('invalid_input');
      if (args.forceAsr !== undefined && typeof args.forceAsr !== 'boolean') throw new SafeError('invalid_input');
      const mode = args.captionsOnly === true ? 'captions' : selected;
      if (operation === 'extract' && args.forceAsr === true && mode === 'captions')
        throw new SafeError('mode_restricted', 'captions 模式禁用 ASR；工具参数不能开其他后端。');
      const language = args.language ?? rawConfig.defaultLanguage ?? 'auto';
      const reason = args.reason ?? 'user_requested';
      if (!['en', 'zh', 'auto'].includes(language) || !REASONS.includes(reason)) throw new SafeError('invalid_input');
      if (operation === 'extract' && (typeof args.target !== 'string' || !args.target.trim() || args.target.length > 4096 || args.target.includes('\0')))
        throw new SafeError('invalid_input', '请提供视频链接或编号。');
      // Capture the non-secret execution environment before any await. A later
      // settings save affects the next request, not half of the current one.
      let selectedState;
      try { selectedState = rawConfig.stateDir; } catch { selectedState = null; }
      const executionConfig = { pythonPath: rawConfig.pythonPath, stateDir: selectedState,
        outputDir: operation === 'extract' ? rawConfig.outputDir : undefined };
      // An explicit output already determines its path: snapshot all settings now.
      // Otherwise resolve the required workspace before touching cookie/key fields.
      let config = operation === 'status' || text(executionConfig.outputDir) ? pythonConfig(mode) : null;
      const workspace = await workspaceFor(execution, operation === 'status' || Boolean(text(executionConfig.outputDir)));
      const base = operation === 'extract' ? taskDirectory(text(executionConfig.outputDir), workspace, 'transcripts') : null;
      config ??= pythonConfig(mode);
      if (mode === 'cloud') {
        secrets = typeof config.cloudApiKey === 'string' ? [config.cloudApiKey] : [];
        if (operation === 'extract' && args.forceAsr === true && config.cloudUploadConsent !== true)
          throw new SafeError('upload_consent_required', '请先在插件设置中授权上传音频；本次没有下载或上传。');
      }
      if (base) scratch = await taskScratch(base);
      context = { workspace: workspace || base, tempDir: scratch?.path };
      if (operation === 'extract' && isBilibiliTarget(args.target) && typeof deps.getBiliCredential === 'function') {
        const credential = await getBiliCredential(execution.signal);
        if (credential?.source === 'managed') {
          const session = credential.sessdata;
          if (typeof session !== 'string' || !session || session.length > 16000 || /[\x00-\x20\x7f-\uffff;]/.test(session))
            throw new SafeError('login_required', 'B站登录已失效，请在 设置→视频学习 中重新扫码。');
          config.biliCookieFile = '';
          config.biliSessdata = session;
          usedBiliSession = session;
          secrets.push(session);
        } else if (credential?.source === 'anonymous') {
          config.biliCookieFile = ''; // 退出后不能又悄悄用回旧文件里的账号
        } else if (credential?.source !== 'legacy_file') {
          throw new SafeError('login_required', 'B站登录状态不可用，请在 设置→视频学习 中检查。');
        }
      }
      const python = await discoverPython(execution.signal, false, executionConfig, context);
      const request = { operation, config };
      if (operation === 'extract') {
        Object.assign(request, { target: args.target, language, reason,
          forceAsr: args.forceAsr === true, captionsOnly: args.captionsOnly === true,
          out: resolve(base, `dsh-video-study-${deps.uuidImpl()}`) });
      }
      const budget = operation === 'status' ? 20000 : extractionBudgetMs(config);
      const result = await runProcess(python.command, [...python.prefix, '-B', join(deps.root, 'python', 'runner.py')],
        { request, timeoutMs: budget, signal: execution.signal, cwd: context.workspace, tempDir: context.tempDir });
      retained = result.processStopped === false || result.processTreeStopped === false;
      if (result.error) return (response = { status: result.error, success: false,
        warnings: [
          ...(result.processStopped === false ? ['子进程退出未确认；临时文件可能残留。'] : []),
          ...(result.processTreeStopped === false ? ['后代进程终止未确认，请检查仍在运行的任务。'] : []),
          ...(result.processStopped !== undefined ? ['强制中止可能遗留临时文件；不能假定 Python 的 finally 已执行。'] : []),
        ],
        message: '操作未完成。' });
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw new SafeError('runner_failed', 'Python 入口未返回单个有效 JSON。'); }
      if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.status !== 'string' || !/^[a-z_]{1,64}$/.test(value.status))
        throw new SafeError('runner_failed', 'Python 入口返回结构无效。');
      if (value.status === 'ok' && result.exitCode !== 0) throw new SafeError('runner_failed', 'Python 进程非正常结束，不标记成功。');
      if (usedBiliSession && value.status === 'login_required' && typeof deps.onBiliRejected === 'function') {
        try { await deps.onBiliRejected(usedBiliSession); } catch { /* 对外错误已经安全 */ }
      }
      response = sanitizeResult(value, secrets);
      if (operation === 'extract' && response.status === 'ok') Object.assign(response, {
        output_style: outputStyle, output_style_label: OUTPUT_STYLE_LABELS[outputStyle],
        output_instructions: OUTPUT_STYLE_INSTRUCTIONS[outputStyle] + ' 原始字幕/ASR稿完整保留；只调整最终课程正文，不覆盖素材，不编造时间戳或公式。',
      });
      return response;
    } catch (error) {
      return (response = { status: error instanceof SafeError ? error.code : 'runner_failed', success: false,
        message: error instanceof SafeError ? error.message : '插件操作失败，原始异常已隐藏。' });
    } finally { await finishScratch(scratch, retained || context?.retained, response); }
  }

  async function setup(args = {}, execution = {}) {
    try {
      if (Object.keys(args).some(key => key !== 'backend')) throw new SafeError('invalid_input');
      const backend = args.backend ?? configuredMode();
      if (!MODES.includes(backend)) throw new SafeError('invalid_input');
      const environment = { pythonPath: rawConfig.pythonPath, stateDir: rawConfig.stateDir };
      const selectedProxy = rawConfig.proxy;
      const workspace = await workspaceFor(execution, true);
      const resolvedState = stateDir(true, environment, workspace);
      const python = await discoverPython(execution.signal, true, environment, { workspace });
      const argv = [...python.prefix, '-B', join(deps.root, 'python', 'setup_environment.py'),
        '--backend', backend, '--state-dir', resolvedState, '--allow-downloads'];
      const proxy = text(selectedProxy);
      if (proxy) {
        let parsed;
        try { parsed = new URL(proxy); } catch { throw new SafeError('invalid_config'); }
        if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
          throw new SafeError('invalid_config', '部署命令只接受不带凭据的 HTTP 代理。');
        argv.push('--proxy', proxy);
      }
      const quote = value => deps.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
      return { status: 'setup_command_prepared', executed: false, backend,
        command: `${deps.platform === 'win32' ? '& ' : ''}${[python.command, ...argv].map(quote).join(' ')}`,
        state_dir: resolvedState,
        warnings: ['只生成命令，不执行安装；普通用户可在设置页点“一键准备运行环境”自动完成。',
          '会创建独立 venv 并安装字幕/Word导出配套依赖，不安装ASR模型。',
          'API 密钥不加密存储；不要写进命令或分享配置。'] };
    } catch (error) {
      return { status: error instanceof SafeError ? error.code : 'setup_failed', executed: false,
        message: error instanceof SafeError ? error.message : '无法生成部署命令。' };
    }
  }
  /** Export only the supplied, already-edited content. Never read ASR/login config
   * or arbitrary source files, and never let tool parameters override the saved
   * directory/format. All content goes through private stdin, not argv. */
  async function exportDocument(args = {}, execution = {}) {
    let scratch, retained = false, response, context;
    try {
      if (execution.signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
      if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['title', 'markdown', 'sourceUrl'].includes(key))
          || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200 || /[\x00-\x1f\x7f]/.test(args.title)
          || typeof args.markdown !== 'string' || !args.markdown.trim() || !args.markdown.isWellFormed()
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.markdown))
        throw new SafeError('invalid_input', '请提供文档标题和已整理的课程正文；输出路径和格式请在设置中选择。');
      let source;
      if (args.sourceUrl !== undefined) {
        try {
          const url = new URL(args.sourceUrl);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
              || typeof args.sourceUrl !== 'string' || args.sourceUrl.length > 4096 || /[\x00-\x20\x7f]/.test(args.sourceUrl)) throw Error();
          source = args.sourceUrl;
        } catch { throw new SafeError('invalid_input', '来源须为不含凭据的公开HTTP(S)链接。'); }
      }
      const format = rawConfig.documentFormat ?? 'docx';
      const selectedDirectory = text(rawConfig.documentOutputDir);
      const environment = { pythonPath: rawConfig.pythonPath, stateDir: rawConfig.stateDir };
      const workspace = await workspaceFor(execution, Boolean(selectedDirectory));
      const directory = taskDirectory(selectedDirectory, workspace, 'documents');
      if (!['docx', 'md', 'txt'].includes(format)) throw new SafeError('invalid_config', '请选择Word、Markdown或纯文本格式。');
      if (!isAbsolute(directory) || /^(?:[\\/]{2})/.test(directory) || /[\x00-\x1f\x7f]/.test(directory)
          || directory.split(/[\\/]/).some(part => part === '..'))
        throw new SafeError('invalid_config', '文档输出目录须为本机绝对路径，不使用网络目录或路径穿越。');
      const request = { title: args.title, markdown: args.markdown, directory, format,
        ...(source === undefined ? {} : { source_url: source }) };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 2 * 1024 * 1024)
        throw new SafeError('invalid_input', '文档请求超过2 MiB，请按章节分文档导出。');
      scratch = await taskScratch(directory);
      context = { workspace: workspace || directory, tempDir: scratch.path };
      const python = await discoverPython(execution.signal, false, environment, context);
      const result = await runProcess(python.command, [...python.prefix, '-B', join(deps.root, 'python', 'document_export.py')],
        { request, timeoutMs: 75000, signal: execution.signal, cwd: context.workspace, tempDir: context.tempDir });
      retained = context.retained || result.processStopped === false || result.processTreeStopped === false;
      if (result.error) throw new SafeError(result.error, retained
        ? '文档导出未完成；进程终止未确认，保留本次临时目录，未自动重试。' : '文档导出未完成；未自动重试。');
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw new SafeError('document_export_failed', '导出进程返回无效结果。'); }
      if (value?.status !== 'ok' || result.exitCode !== 0) {
        const known = ['invalid_input', 'directory_invalid', 'dependency_missing', 'output_exists', 'export_failed'];
        const code = known.includes(value?.code) ? value.code : 'document_export_failed';
        throw new SafeError(code, code === 'dependency_missing'
          ? 'Word导出需要python-docx，请为插件所用Python手动准备依赖；未自动安装。'
          : '文档导出未完成，请检查输出目录、格式及正文；未覆盖已有文件。');
      }
      if (typeof value.document_file !== 'string' || !isAbsolute(value.document_file)
          || resolve(value.document_file, '..') !== resolve(directory)
          || !value.document_file.endsWith('.' + format)) throw new SafeError('document_export_failed', '导出结果的路径或格式无效。');
      return (response = { status: 'ok', success: true, document_file: value.document_file, format, title: args.title,
        formula_count: Number.isSafeInteger(value.formula_count) && value.formula_count >= 0 ? value.formula_count : 0,
        warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string').slice(0, 100) : [] });
    } catch (error) {
      return (response = { status: error instanceof SafeError ? error.code : 'document_export_failed', success: false,
        message: error instanceof SafeError ? error.message : '文档导出失败；原始异常已隐藏，未自动重试。' });
    } finally { await finishScratch(scratch, retained || context?.retained, response); }
  }
  // 一键环境准备：只由用户在设置页显式点击或助手显式调用触发，安装的是本插件
  // 独占的 venv，不碰系统 Python、全局 PATH 或其它目录。
  const INSTALL_TIMEOUT_MS = 1800000;
  const DEPENDENCY_PROBE = 'import importlib.util,json;print(json.dumps({"ytDlp":importlib.util.find_spec("yt_dlp") is not None,"docx":importlib.util.find_spec("docx") is not None}))';
  let installJob = null;
  const managedPython = state => deps.platform === 'win32'
    ? join(state, 'venv', 'Scripts', 'python.exe') : join(state, 'venv', 'bin', 'python');
  function installSnapshot(job) {
    if (!job) return { status: 'idle', running: false, state_dir: defaultStateDir() };
    return { status: job.status, running: !job.finished,
      ...(!job.finished && job.progress ? { progress: job.progress } : {}),
      ...(job.pythonPath ? { python_path: job.pythonPath } : {}),
      ...(job.stateDir ? { state_dir: job.stateDir } : {}),
      ...(job.dependencies ? { dependencies: job.dependencies } : {}),
      ...(job.message ? { message: job.message } : {}),
      ...(job.warnings?.length ? { warnings: job.warnings } : {}) };
  }
  function installCommand(base) {
    const backend = configuredMode();
    const environment = { pythonPath: rawConfig.pythonPath, stateDir: rawConfig.stateDir };
    const selectedProxy = text(rawConfig.proxy);
    return { backend, environment, proxy: selectedProxy, base };
  }
  async function installEnvironment(args = {}, execution = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
      return { status: 'invalid_input', success: false, message: '环境准备不接受工具参数；目录和代理来自已保存的设置。' };
    if (installJob && !installJob.finished) return installSnapshot(installJob);
    try {
      if (execution.signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
      // 自定义解释器下装托管 venv 不会被使用，直接说明而不是假装装好。
      if (text(rawConfig.pythonPath)) throw new SafeError('custom_python_configured',
        '已配置自定义 Python；一键准备只创建插件托管环境。清空 Python 路径或在该环境中自行安装依赖。');
      // 设置页没有会话：状态目录用默认托管位置即可，不要求用户填绝对路径。
      const workspace = await workspaceFor(execution, true);
      const target = stateDir(true, { stateDir: rawConfig.stateDir }, workspace);
      const base = await discoverPython(execution.signal, true, rawConfig, workspace ? { workspace } : {});
      const { backend, proxy } = installCommand(base);
      const argv = [...base.prefix, '-B', join(deps.root, 'python', 'setup_environment.py'),
        '--backend', backend, '--state-dir', target, '--allow-downloads'];
      if (proxy) {
        let parsed;
        try { parsed = new URL(proxy); } catch { throw new SafeError('invalid_config', '代理地址无效。'); }
        if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
          throw new SafeError('invalid_config', '环境准备只接受不带凭据的 HTTP 代理。');
        argv.push('--proxy', proxy);
      }
      const job = { status: 'setup_running', finished: false, venvState: target,
        pythonPath: managedPython(target), stateDir: target, startedAt: Date.now(),
        progress: '正在检查本机 Python…' };
      installJob = job;
      const running = runProcess(base.command, argv, { timeoutMs: INSTALL_TIMEOUT_MS,
        ...(workspace ? { cwd: workspace } : {}),
        onProgress: line => { if (!job.finished) job.progress = line; } });
      void running.then(async result => {
        try {
          if (result.error) {
            const codes = { timeout: 'setup_timeout', cancelled: 'setup_cancelled', output_limit: 'setup_failed' };
            job.status = codes[result.error] ?? 'setup_failed';
            job.message = result.error === 'timeout' ? '安装超时，已停止；可重试。'
              : result.error === 'cancelled' ? '安装已取消。' : '安装未完成；未回显第三方输出。';
            if (result.processStopped === false || result.processTreeStopped === false)
              job.warnings = ['安装进程终止未确认；请检查是否仍有 pip 在运行。'];
            return;
          }
          let value = null;
          try { value = JSON.parse(result.stdout); } catch { value = null; }
          if (!value || typeof value.status !== 'string') { job.status = 'setup_failed'; job.message = '安装脚本未返回有效结果。'; return; }
          if (value.status !== 'prepared_not_runtime_verified') {
            job.status = 'setup_failed';
            job.message = typeof value.message === 'string' ? value.message : '安装失败；未回显第三方输出。';
            return;
          }
          job.status = 'prepared';
          if (typeof value.python === 'string' && isAbsolute(value.python)) job.pythonPath = value.python;
          job.progress = '正在检查刚装好的依赖…';
          const probe = await runProcess(job.pythonPath, ['-B', '-c', DEPENDENCY_PROBE], { timeoutMs: 15000 });
          try {
            const parsed = JSON.parse(probe.stdout);
            job.dependencies = { ytDlp: parsed.ytDlp === true, docx: parsed.docx === true };
            if (!job.dependencies.ytDlp) {
              job.status = 'setup_incomplete';
              job.message = '环境已创建，但未检测到 yt-dlp；请检查网络或代理后重试。';
            }
          } catch { job.dependencies = { ytDlp: false, docx: false }; job.status = 'setup_incomplete';
            job.message = '环境已创建，但依赖自检失败；请重试。'; }
        } finally {
          job.finished = true;
          job.finishedAt = Date.now();
        }
      }, () => { job.status = 'setup_failed'; job.message = '安装进程启动失败。'; job.finished = true; });
      return installSnapshot(job);
    } catch (error) {
      return { status: error instanceof SafeError ? error.code : 'setup_failed', success: false,
        message: error instanceof SafeError ? error.message : '环境准备失败；原始异常已隐藏。' };
    }
  }
  function installStatus() { return installSnapshot(installJob); }
  return { localDefaults: () => ({ platform: deps.platform, stateDir: defaultStateDir() }),
    status: (args, exec) => invoke('status', args, exec), extract: (args, exec) => invoke('extract', args, exec),
    setup, setupInstall: installEnvironment, setupInstallStatus: installStatus, exportDocument,
    dispose: async () => { await Promise.all([...active].map(entry => entry.cancel())); } };
}
