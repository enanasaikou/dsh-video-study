import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime, extractionBudgetMs, REASONS, OUTPUT_STYLES } from './runtime.mjs';
import { createBiliAuth, createBiliApi } from './bili-auth.mjs';
import { createAuthStore } from './auth-store.mjs';
import { registerAuthSettings } from './auth-settings.mjs';
import { registerAsrSettings } from './asr-settings.mjs';
import { liveConfig, LIVE_FIELDS } from './config-values.mjs';
import { createLocalPathPicker } from './local-path-picker.mjs';

/** 原生 Cordis/Schemastery 配置，不含任何机器相关默认值。 */
export function createConfig(z) {
  const fields = {
    mode: z.union(['captions', 'cloud']).description('captions 只用现有字幕；cloud 经授权上传 ASR。默认不下载音轨。').default('captions'),
    defaultLanguage: z.union(['en', 'zh', 'auto']).default('auto'),
    pythonPath: z.string().default(''),
    stateDir: z.string().default(''),
    outputDir: z.string().description('原始字幕、ASR和元数据目录；与整理讲义的文档目录分开。').default(''),
    documentOutputDir: z.string().description('整理讲义本机绝对目录；留空使用当前会话工作区/video-study/documents。').default(''),
    documentFormat: z.union(['docx', 'md', 'txt']).description('整理正文导出格式；Word使用可编辑公式，不表示已自动核实公式。').default('docx'),
    cloudProviderName: z.string().description('自定义服务名称，仅供显示，不参与协议或域名判断。').default(''),
    cloudProtocol: z.union(['auto', 'openai', 'dashscope_paraformer', 'dashscope_qwen', 'volcengine_flash', 'tencent_rec_task']).description('按接口协议连接，不按厂商白名单；auto仅兼容旧配置。').default('auto'),
    cloudResponseFormat: z.union(['verbose_json', 'json', 'provider_default']).description('OpenAI兼容协议请求格式；服务默认仅发文件和模型，不强求时间戳扩展。').default('verbose_json'),
    cloudAppId: z.string().description('应用/凭据标识：火山App ID、腾讯SecretId；不是私钥。').default(''),
    cloudRegion: z.string().description('腾讯地域等协议参数，不是服务厂商限制。').default(''),
    cloudResourceId: z.string().description('火山语音资源ID等协议参数。').default(''),
    cloudEndpoint: z.string().description('自定义完整HTTPS请求地址，路径不限定厂商；不含URL凭据、查询参数或片段。').default(''),
    // role('secret') 只控制宿主界面显示，不代表加密存储。
    // 可编辑字段用 volatile；消费层按需 .get()，不预读未选后端的密钥。
    cloudApiKey: z.string().role('secret').description('云端密钥，只经标准输入传递；不加密存储，分享配置前删除。').default(''),
    cloudApiKeyFile: z.string().description('可选密钥文件绝对路径；只有真实云端 ASR 时才读取。').default(''),
    cloudModel: z.string().description('服务实际支持的转写模型名；需返回段落级时间戳。').default(''),
    cloudUploadConsent: z.boolean().description('确认允许把音频上传到所配置服务，可能产生费用。').default(false),
    allowInsecureLoopback: z.boolean().default(false),
    cloudMaxAudioMiB: z.number().description('单次云端音轨上限（MiB）；最大 512，且受服务自身限制。').default(25),
    proxy: z.string().default(''),
    youtubeCookieFile: z.string().default(''),
    biliCookieFile: z.string().default(''),
    downloadTimeout: z.number().default(300),
    asrTimeout: z.number().default(3600),
    maxDuration: z.number().default(14400),
    registerSkill: z.boolean().default(true),
  };
  for (const name of LIVE_FIELDS) fields[name] = fields[name].volatile();
  return z.object(fields);
}

const output = {
  schema: { type: 'object', additionalProperties: true, properties: {
    status: { type: 'string', required: true },
    message: { type: 'string' }, success: { type: 'boolean' },
    output: { type: 'string' }, metadata_file: { type: 'string' }, transcript_file: { type: 'string' },
    caption_kind: { type: 'string' }, language: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

/** 与 SDK 解耦，便于离线测试工具定义。 */
export function createToolDefinitions(config, runtime) {
  return [
    { name: 'video_study_status', description: '离线检查插件、Python 与所选后端状态；不联网、不下载。',
      timeoutMs: 45000, parameters: {}, output,
      execute: (args, exec) => runtime.status(args, exec),
      presentCall: () => ({ card: 'generic', title: '视频学习：离线状态', kind: 'other' }) },
    { name: 'video_study_extract',
      description: '提取前必须通过提问工具询问本次输出详略：原文（完全复述）/简要压缩/总结，并传 outputStyle；用户本次已明确选择则不重复问，不沿用上次选择。始终完整提取原始字幕/ASR稿，仅最终课程正文按选择整理。无字幕或目标语言不可用时才用已配置 cloud；网络或权限错误不触发 ASR，上传另需授权。',
      timeoutMs: extractionBudgetMs(config, 150), parameters: {
        target: { type: 'string', required: true, description: '视频链接或编号；B站链接保留分 P。' },
        outputStyle: { type: 'string', required: true, enum: OUTPUT_STYLES,
          description: '用户本次选择的输出详略：verbatim=原文（完全复述），concise=简要压缩，summary=总结。未选先提问，不猜测、不沿用上次；不影响完整原始转写稿。' },
        language: { type: 'string', enum: ['en', 'zh', 'auto'], description: '原始语言；缺省用配置（默认 auto）。已知英语用 en，中文用 zh。' },
        forceAsr: { type: 'boolean', description: '强制重新识别音轨；captions 模式禁用。' },
        reason: { type: 'string', enum: REASONS, description: 'ASR 原因；缺省 user_requested。' },
        captionsOnly: { type: 'boolean', description: 'true 时只取现有字幕，不读云端密钥、不跑 ASR。' },
      }, output,
      execute: (args, exec) => runtime.extract(args, exec),
      presentCall: () => ({ card: 'generic', title: '视频学习：提取资料', kind: 'other' }) },
    { name: 'video_study_export',
      description: '将已通读、整理并核对公式的课程正文离线导出为一个最终文件（Word/Markdown/TXT），使用设置中的文档目录和格式。备注仅保留必要的“识别字幕→改正字幕”，不为讲者说得不全面补充长篇说明；不附送源稿、测试文件或报告。不提取视频、不调用ASR、不自动总结或声称公式已验证。Word支持常用LaTeX到可编辑公式，未知语法原样保留并警告。',
      timeoutMs: 90000, parameters: {
        title: { type: 'string', required: true, description: '课程文档标题，不是文件路径。' },
        markdown: { type: 'string', required: true, description: '助手已完整整理的正文Markdown，公式用$...$或$$...$$；必要订正只写“识别字幕→改正字幕”，不写补全理论或防御性长备注，不把未核实内容硬改。' },
        sourceUrl: { type: 'string', description: '原课程公开来源链接；B站保留分P。不含凭据或签名。' },
      }, output,
      execute: (args, exec) => runtime.exportDocument(args, exec),
      presentCall: () => ({ card: 'generic', title: '视频学习：导出课程文档', kind: 'other' }) },
    { name: 'video_study_setup',
      description: '生成可自行检查、手动执行的环境部署命令；不安装、不下载、不改配置。普通用户不需要它：DSH 设置→视频学习 里有“一键准备运行环境”按钮，由用户自己点击安装。',
      timeoutMs: 30000, parameters: {
        backend: { type: 'string', enum: ['captions', 'cloud'], description: '要部署的后端；缺省用当前模式。不下载ASR模型。' },
      }, output,
      execute: (args, exec) => runtime.setup(args, exec),
      presentCall: () => ({ card: 'generic', title: '视频学习：准备部署命令（不执行）', kind: 'other' }) },
  ];
}

export function createSkillProvider(rank = 600) {
  const locator = new URL('../skills/video-study/SKILL.md', import.meta.url);
  const resourceBase = { kind: 'directory', path: fileURLToPath(new URL('../skills/video-study/', import.meta.url)) };
  const candidate = { name: 'video-study', description: '转写前询问原文（完全复述）/简要压缩/总结；提取 YouTube/B站字幕并按本次选择整理，默认只用现有字幕，按配置可选云端 ASR。',
    invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-video-study',
    source: 'bundled', resourceBase, rank, locator };
  return { name: 'dsh-video-study', list: async () => [candidate],
    async get() { const { locator: _locator, rank: _rank, ...record } = candidate;
      return { ...record, content: await readFile(locator, 'utf8') }; } };
}

export function applyPlugin(ctx, config, { defineTool, rank = 600, runtimeFactory = createRuntime,
  authKey, authFactory = createBiliAuth, apiFactory = createBiliApi, storeFactory = createAuthStore } = {}) {
  config = liveConfig(config); // keep native refs live; never eagerly spread secrets
  // 宿主凭据服务里只存 DPAPI 密文，不存明文会话。
  const store = storeFactory({ key: authKey,
    credentials: () => typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials });
  let api, apiProxy;
  const privateApi = Object.fromEntries(['generateQr', 'pollQr', 'check'].map(method => [method,
    (...args) => {
      const proxy = config.proxy;
      if (api && proxy !== apiProxy) { api.dispose?.(); api = undefined; }
      if (!api) { api = apiFactory({ proxy }); apiProxy = proxy; }
      return api[method](...args);
    }]));
  privateApi.dispose = () => api?.dispose?.();
  const auth = authFactory({ store, api: privateApi, legacyCookieFile: config.biliCookieFile });
  const runtime = runtimeFactory(config, {
    // Resolve the calling Session on every request; neither process.cwd() nor
    // session.header.cwd follows the user's later working_directory changes.
    getWorkspace: async (execution = {}) => {
      if (!execution.agent) return null;
      const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory;
      return typeof directories?.ensure === 'function' ? directories.ensure(execution.agent, execution.signal) : null;
    },
    getBiliCredential: () => auth.credentialForRequest(),
    onBiliRejected: expected => auth.markRejected(expected),
  });
  // Optional host capability: CLI/caption tools must not depend on a GUI picker.
  let directoryPicker;
  ctx.inject(['directoryPicker'], pickerCtx => {
    const service = pickerCtx.directoryPicker; directoryPicker = service;
    pickerCtx.effect(() => () => { if (directoryPicker === service) directoryPicker = undefined; });
  });
  const pickPath = createLocalPathPicker({ getCapability: () => directoryPicker?.capability() });
  let toolDisposers = [];
  const refreshTools = () => {
    for (const dispose of toolDisposers) if (typeof dispose === 'function') dispose();
    toolDisposers = createToolDefinitions(config, runtime).map(definition => ctx.tools.register(defineTool(definition)));
  };
  refreshTools();
  // Native volatile writes keep apply alive. Refresh declarations too, so an
  // ASR selection does not retain the old caption-only timeout metadata.
  if (typeof ctx.on === 'function') ctx.on('loader/volatile-update', refreshTools);
  ctx.effect(() => async () => {
    for (const dispose of toolDisposers) if (typeof dispose === 'function') dispose();
    toolDisposers = []; pickPath.dispose(); await runtime.dispose(); await auth.dispose();
  });
  // 走 ctx.connection.fetch 的宿主鉴权网关；不要另开未鉴权的 HTTP 入口或登录工具。
  ctx.inject(['connection'], webCtx => {
    if (webCtx.connection?.fetch?.register) return registerAuthSettings(webCtx, auth);
  });
  ctx.inject(['connection', 'settings', 'configEditor'], webCtx => {
    if (!webCtx.connection?.fetch?.register || !webCtx.settings || !webCtx.configEditor) return;
    // Our native section contains the form; avoid a second auto-generated page.
    if (ctx.fiber && typeof webCtx.effect === 'function' && typeof webCtx.settings.configure === 'function')
      webCtx.effect(() => webCtx.settings.configure({ auto: false }, ctx.fiber));
    return registerAsrSettings(webCtx, { runtime, pickPath, resolvePath: pickPath.resolve, ownerContext: ctx,
      hasSecret: () => { const key = config.cloudApiKey; return typeof key === 'string' && key.length > 0; } });
  });
  if (config.registerSkill !== false) ctx.inject(['skills'], skillCtx => {
    skillCtx.skills.registerProvider(() => createSkillProvider(rank));
  });
}
