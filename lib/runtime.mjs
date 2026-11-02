import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { liveConfig } from './config-values.mjs';

export const MODES = ['captions', 'cloud', 'local'];
export const LOCAL_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];
export const REASONS = ['no_captions', 'language_unavailable', 'unreliable_captions', 'user_requested'];
export const DEFAULTS = Object.freeze({ mode: 'captions', localDevice: 'cpu', localComputeType: 'int8',
  localModel: 'small', defaultLanguage: 'auto', cloudUploadConsent: false, allowInsecureLoopback: false,
  cloudMaxAudioMiB: 25, downloadTimeout: 300, asrTimeout: 3600, maxDuration: 14400,
  registerSkill: true });
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
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
  const deps = { spawnImpl: spawn, accessImpl: access, homedirImpl: homedir, tmpdirImpl: tmpdir,
    uuidImpl: randomUUID, platform: process.platform, root: packageRoot,
    terminateImpl: terminateProcessTree, timeoutScale: 1, ...dependencies };
  const active = new Set();
  const defaultStateDir = () => join(deps.homedirImpl(), '.dsh', 'state', 'dsh-video-study');
  // undefined 才取默认值：null/非法值原样交给 Python，由它在真正走 ASR 时拒绝。
  const take = (key, fallback = DEFAULTS[key] ?? '') => {
    const value = rawConfig[key]; return value === undefined ? fallback : value;
  };
  const stateDir = (strict = true, view = rawConfig) => {
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
    if (!MODES.includes(mode)) throw new SafeError('invalid_config', '模式必须是 captions、cloud 或 local。');
    return mode;
  };
  // 不 spread rawConfig：captions 不能碰到后端字段，local 不能读到云端密钥。
  function pythonConfig(mode) {
    const config = { mode, proxy: text(rawConfig.proxy),
      youtubeCookieFile: text(rawConfig.youtubeCookieFile), biliCookieFile: text(rawConfig.biliCookieFile) };
    if (mode === 'captions') return config;
    for (const key of ['downloadTimeout', 'asrTimeout', 'maxDuration']) config[key] = take(key);
    if (mode === 'local') {
      config.stateDir = take('stateDir', defaultStateDir());
      config.localModel = take('localModel');
      config.localModelDir = take('localModelDir');
      config.localDevice = take('localDevice');
      config.localComputeType = take('localComputeType', config.localDevice === 'cuda' ? 'float16' : 'int8');
    }
    if (mode === 'cloud') {
      for (const key of ['cloudProviderName', 'cloudProtocol', 'cloudResponseFormat', 'cloudAppId', 'cloudRegion', 'cloudResourceId',
        'cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudModel',
        'cloudUploadConsent', 'allowInsecureLoopback', 'cloudMaxAudioMiB']) config[key] = take(key);
    }
    return config;
  }

  /** stdout 有上限、stderr 丢弃，任何原始异常文本都不外露。 */
  function runProcess(command, args, { request, timeoutMs, signal } = {}) {
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
          detached: deps.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (error) { finish({ error: error?.code === 'ENOENT' ? 'dependency_missing' : 'runner_failed' }); return; }
      child.once('error', error => finish({ error: interruption ?? (error?.code === 'ENOENT' ? 'dependency_missing' : 'runner_failed') }));
      child.stdout.on('data', chunk => {
        if (settled || interruption) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_STDOUT_BYTES) { stop('output_limit'); return; }
        chunks.push(Buffer.from(chunk));
      });
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

  async function discoverPython(signal, forSetup = false, view = rawConfig) {
    const explicit = text(view.pythonPath);
    let candidates = [];
    if (explicit) candidates.push(explicit === 'py -3' ? { command: 'py', prefix: ['-3'] } : { command: explicit, prefix: [] });
    else {
      if (!forSetup) {
        let managedState;
        try { managedState = stateDir(false, view); } catch { managedState = null; }
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
      const result = await runProcess(candidate.command, [...candidate.prefix, '-B', '-c', PROBE_CODE], { timeoutMs: 5000, signal });
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
    let secrets = [], usedBiliSession;
    try {
      if (execution.signal?.aborted) throw new SafeError('cancelled', '操作已取消。');
      const allowed = operation === 'status' ? [] : ['target', 'language', 'forceAsr', 'reason', 'captionsOnly'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new SafeError('invalid_input', '工具参数不能修改后端、凭据或输出路径。');
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
      const config = pythonConfig(mode);
      if (mode === 'cloud') {
        secrets = typeof config.cloudApiKey === 'string' ? [config.cloudApiKey] : [];
        if (operation === 'extract' && args.forceAsr === true && config.cloudUploadConsent !== true)
          throw new SafeError('upload_consent_required', '请先在插件设置中授权上传音频；本次没有下载或上传。');
      }
      // Capture the non-secret execution environment before any await. A later
      // settings save affects the next request, not half of the current one.
      let selectedState;
      try { selectedState = rawConfig.stateDir; } catch { selectedState = null; }
      const executionConfig = { pythonPath: rawConfig.pythonPath, stateDir: selectedState,
        outputDir: operation === 'extract' ? rawConfig.outputDir : undefined };
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
      const python = await discoverPython(execution.signal, false, executionConfig);
      const request = { operation, config };
      if (operation === 'extract') {
        const base = text(executionConfig.outputDir) || deps.tmpdirImpl();
        if (!isAbsolute(base)) throw new SafeError('invalid_config', 'outputDir 必须为绝对路径。');
        Object.assign(request, { target: args.target, language, reason,
          forceAsr: args.forceAsr === true, captionsOnly: args.captionsOnly === true,
          out: resolve(base, `dsh-video-study-${deps.uuidImpl()}`) });
      }
      const budget = operation === 'status' ? 20000 : extractionBudgetMs(config);
      const result = await runProcess(python.command, [...python.prefix, '-B', join(deps.root, 'python', 'runner.py')],
        { request, timeoutMs: budget, signal: execution.signal });
      if (result.error) return { status: result.error, success: false,
        warnings: [
          ...(result.processStopped === false ? ['子进程退出未确认；临时文件可能残留。'] : []),
          ...(result.processTreeStopped === false ? ['后代进程终止未确认，请检查仍在运行的任务。'] : []),
          ...(result.processStopped !== undefined ? ['强制中止可能遗留临时文件；不能假定 Python 的 finally 已执行。'] : []),
        ],
        message: '操作未完成。' };
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw new SafeError('runner_failed', 'Python 入口未返回单个有效 JSON。'); }
      if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.status !== 'string' || !/^[a-z_]{1,64}$/.test(value.status))
        throw new SafeError('runner_failed', 'Python 入口返回结构无效。');
      if (value.status === 'ok' && result.exitCode !== 0) throw new SafeError('runner_failed', 'Python 进程非正常结束，不标记成功。');
      if (usedBiliSession && value.status === 'login_required' && typeof deps.onBiliRejected === 'function') {
        try { await deps.onBiliRejected(usedBiliSession); } catch { /* 对外错误已经安全 */ }
      }
      return sanitizeResult(value, secrets);
    } catch (error) {
      return { status: error instanceof SafeError ? error.code : 'runner_failed', success: false,
        message: error instanceof SafeError ? error.message : '插件操作失败，原始异常已隐藏。' };
    }
  }

  async function setup(args = {}, execution = {}) {
    try {
      if (Object.keys(args).some(key => !['backend', 'model'].includes(key))) throw new SafeError('invalid_input');
      const backend = args.backend ?? configuredMode();
      const model = args.model ?? rawConfig.localModel ?? 'small';
      if (!MODES.includes(backend) || !LOCAL_MODELS.includes(model)) throw new SafeError('invalid_input');
      const environment = { pythonPath: rawConfig.pythonPath, stateDir: rawConfig.stateDir };
      const selectedProxy = rawConfig.proxy;
      const python = await discoverPython(execution.signal, true, environment);
      const resolvedState = stateDir(true, environment);
      const argv = [...python.prefix, '-B', join(deps.root, 'python', 'setup_environment.py'),
        '--backend', backend, '--state-dir', resolvedState, '--model', model, '--allow-downloads'];
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
        state_dir: resolvedState, local_model_dir: join(resolvedState, 'models', model),
        warnings: ['只生成命令，不执行安装；请检查后手动运行。',
          '会创建独立 venv；local 还会下载公开模型，大小取决于所选模型。',
          'API 密钥不加密存储；不要写进命令或分享配置。'] };
    } catch (error) {
      return { status: error instanceof SafeError ? error.code : 'setup_failed', executed: false,
        message: error instanceof SafeError ? error.message : '无法生成部署命令。' };
    }
  }
  return { status: (args, exec) => invoke('status', args, exec), extract: (args, exec) => invoke('extract', args, exec),
    setup, dispose: async () => { await Promise.all([...active].map(entry => entry.cancel())); } };
}
