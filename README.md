# dsh-video-study

YouTube / B站字幕与课程学习插件。默认只取已有字幕；要用语音识别时由用户选云端 API 或本机模型。脚本、技能、工具随插件分发。

## 三种模式

| `mode` | 行为 | 本机额外要求 |
|---|---|---|
| `captions`（默认） | 只用现有字幕；无源语言字幕就停止，不下载音轨、不跑 ASR | 无 |
| `cloud` | 字幕优先；需 ASR 时上传到配置的转写服务 | 服务账号与上传授权，可能收费 |
| `local` | 字幕优先；需 ASR 时用本机 faster-whisper | 可选 ASR 环境与本地模型 |

所有模式都要 Python 3.10+。YouTube 提取依赖 yt-dlp，B站字幕和云端只用标准库。插件不打包 Node、Python、ffmpeg、模型或宿主 SDK。火山引擎协议只收 WAV/MP3/OGG OPUS，其它格式（B站常见的 m4a/AAC、webm 等）需要本机已有的 ffmpeg 做一次本地转码：插件只调用你 PATH 上的 ffmpeg，输出 16 kHz 单声道 64 kbps MP3 到任务临时目录，不联网、不截断、不改变平台时长；找不到 ffmpeg 就报缺依赖，不会把后缀改掉伪装上传。

## 安装

从 GitHub 安装（推荐）：

```sh
dsh plugin --profile desktop add github:enanasaikou/dsh-video-study
```

公开仓库可匿名安装；私有仓库要求本机已有该仓库的 git 访问凭据。也可以先 clone 再本地安装，或安装 release 里的 `.tgz`：

```sh
# 在包目录的上一级
dsh plugin --profile desktop add ./dsh-video-study
# 或安装 .tgz
dsh plugin --profile desktop add ./dsh-video-study-0.5.2.tgz
```

装完重启或重载 profile。包用标准 `dsh.bundle.patch` + Cordis 工具插件 + bundled skill，兼容 `>=0.2.1-rc.5 <0.3.0`，只在 `0.2.1-rc.5` 验证过。

安装不装 pip 包、不下载模型、不读浏览器 Cookie、不上传音频、不访问 API。各电脑填自己的配置；不要打包分享密钥、Cookie、模型或虚拟环境。

## 快速开始

1. 装插件并重载 profile。
2. 打开 **DSH 设置 → 视频学习**，模式选「仅现有字幕」先跑一个视频，确认 Python 与 B站登录态正常（`video_study_status` 可离线自检）。
3. 需要语音识别时再切到「云端 ASR」或「本机 ASR」，按下面的配置节填写并**勾选上传授权**。
4. 长课程（30 分钟这种）请选异步协议，例如预设「阿里 Qwen 文件转写（长录音）」：同步接口通常只有 5 分钟 / 10 MB 的单条上限。

## 隐私与数据流

无遥测、无统计、无硬编码第三方端点；音频只在你勾选上传授权后发往你自己填写的 API 地址；B站会话只存本机凭据服务（Windows 上为 DPAPI 密文）。完整说明见 [SECURITY.md](SECURITY.md)。

## 兼容性与验证范围

- 宿主：DSH `>=0.2.1-rc.5 <0.3.0`，Node `>=22.19.0`，Python 3.10+。
- 本版本经过**离线**验证：Node 224 项、Python 351 项、宿主桥接 62 + 78 项检查、打包与归档校验；**尚未**对真实云端服务完成契约验收（各家的上传策略、结果域名、错误码仍可能变化）。
- 云端服务侧的变化由服务方决定；遇到不可解读的失败，插件只报固定错误码，不回显服务原始响应，也不会自动重试或重复提交收费任务。

## 工具

- `video_study_status`：离线检查 Python、模式与静态配置，不联网，无参数。
- `video_study_extract`：先取现有字幕，按设置决定是否后备 ASR。参数 `target`、`language`、`forceAsr`、`reason`、`captionsOnly`。
- `video_study_setup`：只生成环境部署命令，用户检查后手动执行。参数 `backend`、`model`。
- 技能 `video-study`：随包注册，指导阅读、核对、翻译与课程译写。

插件不自动替换旧的 `youtube-study-notes` / `video-course-handouts`。

## 设置 → 视频学习：B站登录

在 **DSH 设置 → 视频学习** 里操作。登录和ASR配置放在同一标签；请用0.5.2或更新版本，升级后完整重载DSH，只刷新页面不一定能换后端代码。

0.5.2 让 `dashscope_paraformer`（阿里原生异步）协议支持 Qwen 文件转写模型：`qwen3-asr-flash-filetrans` 这类 `*filetrans` 模型走 `input.file_url` 单体提交、从 `output.result.transcription_url` 取结果，返回真实毫秒级分段，可处理长录音（同步 `qwen3-asr-flash` 走 OpenAI 兼容通道，单条上限 5 分钟、Base64 编码后 10MB）。服务返回的结果地址若是明文 `http`，只在该 filetrans 通道接受并写入 warning，其它协议仍要求 HTTPS。若把 `*filetrans` 模型配到 `dashscope_qwen` 协议，保存检查会直接报“协议与模型不匹配”，不再等云端返回无法解读的 4xx。用自建/转售网关时，存储桶可落在任意 `*.oss-<region>.aliyuncs.com` 地域，但结果地址必须与上传策略返回的地域一致。

0.5.1 修正了更改服务目标时的凭据处理：0.5.0 会在改地址/协议时把已保存的 Key 一起删除，而多数厂商不提供再次查看 Key，删掉就等于永久丢失。现在只撤销上传授权、保留 Key，重新勾选授权后该 Key 才会发往新地址。

0.5.0把云端ASR做成自定义厂商 + 显式协议：服务名、API 地址、模型、Key 都由你填，协议从 `auto`、`openai`、`dashscope_paraformer`、`dashscope_qwen`、`volcengine_flash`、`tencent_rec_task` 里选，`auto` 只按地址识别阿里原生接口、其余都走 OpenAI 兼容。页面提供硅基流动、Paraformer、Qwen-ASR、火山极速、腾讯录音识别和 Groq 的预设按钮，预设只填表，填完仍可改，不会保存、不会联网、也不代表服务一定支持该模型。只改显示名称或模型不会影响凭据；改 API 地址、协议、AppID、地域或资源 ID 时会撤销上传授权，但**不会删除已保存的 Key**（多数厂商不允许再次查看 Key，删掉就无法找回），重新勾选上传授权后这个 Key 才会发往新地址，请先确认地址可信。Qwen 和硅基流动只返回纯文本：不伪造时间戳、不生成 SRT/VTT，仅在 TXT/MD 里给正文。

0.4.0取消了模型名称的ASCII命名规则和100字符上限，不修剪或截断输入；取消Key的8字符下限，并为保存错误标注具体字段。保留控制字符、HTTPS、请求头安全边界（Key最多8192 ASCII字符）和整个保存请求64 KiB上限，这些不是模型名称规则或转写文本字数限制。新增阿里百炼 Paraformer 原生录音转写协议，不能把任意阿里模型当成OpenAI接口。

0.3.1修复了0.3.0的设置读取兼容问题：如果模式框变灰并提示“设置服务返回格式无效”，不是缺模型，而是旧版没有成功读取配置。正常载入后，三种模式都可直接选择。

1. 点 **扫码登录**，二维码在本页绘制。
2. 用B站 App 扫码，并在手机上确认。
3. 插件再查一次登录态，成功才接受会话；二维码过期或风控失败就停止，不自动重试。
4. 之后照常提取字幕；会话由后台经私有 stdin 交给 Python，不进入工具参数、聊天、命令行或临时文件。
5. **检查** 验证状态，失效就重新扫码。**退出** 只删本插件的登录记录，不注销其他B站设备，不删你原来的Cookie文件。

**导入 Cookie 文件** 只读你选的 JSON，≤64 KiB，接受含 SESSDATA 的对象或带 B站域名的 Cookie 数组；只留必要字段，先验证再用。插件不读浏览器 Cookie，也不收集密码。

**存储**：credentials-local 默认是 YAML 不是保险库，插件只把 DPAPI 密文写进宿主凭据服务中本插件的命名空间，仅同一 Windows 用户能解密。其他平台或加密不可用时只存进程内存，重启需重新登录。写入失败会报错。

不要分享二维码截图、Cookie 或凭据备份。

扫码走 B站网页接口，不是官方 OAuth，接口可能改版或触发风控。扫码和登录检查只支持直连，配置 `proxy` 会报不支持；字幕和音轨通道仍按 `proxy` 工作。YouTube 公开课程默认匿名，不用 Google 登录或 B站会话；`youtubeCookieFile` 仅为兼容保留，默认空。

## 配置

在同一标签的 **字幕与ASR** 里选“仅现有字幕 / 云端ASR / 本机ASR”，然后点 **保存设置**；不在对话中修改后端。配置保存到DSH原生配置，下一次提取生效，已经运行的任务保持原配置。

- 云端：填服务名（可选，仅用于显示）、API地址、协议、响应格式、模型、Key，并勾选上传音频授权；火山/腾讯还要填 AppID，火山填地域与资源ID，腾讯按需填地域。Key不会读回，留空保留旧值；需要删除时勾“清除已保存的Key”。改服务目标（地址/协议/AppID/地域/资源ID）会保留已保存的Key、只撤销上传授权，重新勾选授权后Key会发往新地址。
- 本机：选模型、模型目录、设备与Python路径；其他目录、代理和超时在“高级设置”。
- 保存后可点 **检查环境**，只做离线配置/依赖检查，不验证Key、余额或服务连通。**生成部署命令** 只显示命令，检查后由用户手动运行，不自动安装或转写。
- 遇到其它位置同时改配置，页面会提示重新载入，不会悄悄覆盖。

工具参数不能切换后端。配置空缺时仍可先取已有字幕，真要走ASR才预检缺什么。

### 1. `captions`：不配置 ASR

保持 `mode: captions`。默认不带 Cookie；字幕需要登录时停止说明，不用浏览器登录态。YouTube 自动翻译轨不当源语言字幕；B站按分 P 选 CID，不走旧 `/x/player/v2`。平台没标 AI 的也可能没人校订。

### 2. `cloud`：不需要本机模型

0.5.0 使用**自定义服务 + 显式接口协议**。服务名称不决定代码路径，预设只是可编辑的填表建议；不是厂商白名单，也不会自动保存或授权上传。

- `cloudProviderName`：任意显示名称，不参与路由。
- `cloudProtocol`：`openai` / `dashscope_paraformer` / `dashscope_qwen` / `volcengine_flash` / `tencent_rec_task`。`auto` 只兼容旧配置；新配置建议显式选择。
- `cloudEndpoint`：完整 HTTPS 请求 URL，允许自建网关、其它域名和路径，不要求固定 `/audio/transcriptions` 后缀；不接受 URL 内嵌凭据、查询参数、片段或路径穿越。填哪个地址就把凭据发到哪个地址，请自行核实可信度。自定义地址不代表任意未知协议都会工作。
- `cloudModel`：真实模型/引擎参数，原样透传，不限制厂商命名、空格、中文、标点或单独字数；拒控制字符、非法 Unicode，整个保存请求仍限64 KiB。
- `cloudApiKey`：secret 框中的 Key、火山 Access Token 或腾讯 SecretKey。也可用 `cloudApiKeyFile` 指定绝对路径的 UTF-8 密钥文件；不读环境密钥，不向对话/命令行暴露。
- `cloudAppId`：火山 App ID / 腾讯 SecretId（公开凭据标识，不是私钥）；`cloudRegion` 为地域，`cloudResourceId` 为语音资源ID。
- `cloudUploadConsent: true`：对当前目标明确授权上传。更改 URL、协议、凭据标识、地域或资源ID会保留已保存的Key/Key文件、只把授权置为 false；同一保存中显式带上 `cloudUploadConsent: true` 即视为用户确认把保留的Key发往新目标，再次保存不加勾选则保持撤销状态。只改显示名称或模型不切换服务。
- `cloudMaxAudioMiB` 默认25、最大512；还受下面各协议更小的限制，不自动切片/换服务。

| 预设 | 协议 | 默认完整地址 / 模型 | 凭据与输出 |
|---|---|---|---|
| 硅基流动 | `openai` | `https://api.siliconflow.cn/v1/audio/transcriptions` / `FunAudioLLM/SenseVoiceSmall` | Bearer Key；选择服务默认格式；可只返回正文 |
| 阿里 Paraformer | `dashscope_paraformer` | `https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription` / `paraformer-v2` | Bearer Key；真实句级时间戳 |
| 阿里 Qwen 文件转写 | `dashscope_paraformer` | 同上地址 / `qwen3-asr-flash-filetrans` | Bearer Key；异步任务 + 临时OSS上传；真实句级时间戳，适合长录音 |
| 阿里 Qwen-ASR | `dashscope_qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` / `qwen3-asr-flash` | Bearer Key；聊天接口中的音频 Data URI，正文模式 |
| 火山/豆包极速版 | `volcengine_flash` | `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` / `bigmodel` | App ID + Access Token，资源 `volc.bigasr.auc_turbo`；真实 utterances |
| 腾讯云录音识别 | `tencent_rec_task` | `https://asr.tencentcloudapi.com/` / `16k_zh` | SecretId + SecretKey，TC3签名；地域可空或 `ap-guangzhou`；真实 ResultDetail |
| Groq | `openai` | `https://api.groq.com/openai/v1/audio/transcriptions` / `whisper-large-v3-turbo` | Bearer Key；分段扩展 |

**OpenAI兼容**的 `cloudResponseFormat` 有三种：`verbose_json` 保留原分段请求；`json` 请求JSON正文；`provider_default` 只传 `model` 和 `file`，不发送语言、格式或时间戳扩展，兼容只接受两字段的服务。响应有真实segments就保留；只有非空text时生成无时间戳TXT/Markdown，标记 `timestamps_available=false`、`segments=[]`，不伪造时间、不生成SRT。Qwen聊天协议同样只使用实际正文，音频Base64编码后上限10 MB。

**火山/腾讯限制**：火山极速接口本地文件上限100,000,000字节，服务还要求不超过2小时；本插件不解码测时长，只核验平台元数据，因此不能保证服务接收。火山只收 WAV/MP3/OGG OPUS，其它容器（m4a/mp4/webm/flac/aac）用你 PATH 上的 ffmpeg 本地转成 16 kHz 单声道 MP3 再上传，属于离线预处理、按上限保护、不截断；没有 ffmpeg 就明确报缺依赖。腾讯仅实现内联Data模式，上限5,000,000字节，不暗中上传第三方存储或转URL模式；超限提前拒绝。部分不提供句级时间戳的腾讯引擎会明确拒绝，不拿整段文字猜时间。当前不是实时/流式识别客户端。

**Paraformer**：上传策略 → 严格地域阿里临时OSS → 单次JSON异步提交 → 同API主机GET轮询 → 阿里结果JSON。主Key只给原API主机，OSS/结果不带主Key；二级地址仍受阿里OSS地域HTTPS白名单保护（这不是自定义主API的厂商白名单）。新工作空间可填自己的 `*.cn-beijing.maas.aliyuncs.com` 完整URL，新加坡可填 `dashscope-intl.aliyuncs.com`，用对应地域Key；自定义网关时用 `cloudRegion` 明确OSS地域。模型参数透传，是否受服务支持最终由服务判断。

**临时文件/费用**：Paraformer临时OSS约48小时清理；异步任务取消、超时或本机进程结束后可能继续并收费，未实现远端取消且不自动重提。`asrTimeout` 是整条本地流程总预算，不是服务完成保证。不保存远端任务ID、签名URL、策略或音频Base64。语言是请求提示或模型参数，不伪称实际识别语言；服务不返回语言时标unknown。

本版验证为离线fake-network和宿主桥接测试，**未用真实账号做服务端契约/计费验收**。预设和官方文档不等于所有地域/模型实际可用。

官方协议：[Paraformer](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)、[临时上传](https://help.aliyun.com/en/model-studio/get-temporary-file-url)、[Qwen-ASR](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference)、[硅基流动](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post)、[火山极速](https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-lite-recognition-api?lang=en)、[腾讯创建任务](https://cloud.tencent.com/document/api/1093/37823)、[腾讯查询任务](https://cloud.tencent.com/document/api/1093/37822)。

音轨在本机流式下载后上传；不分块，超过服务文件上限就停止。默认 HTTPS、禁止重定向，API Key 只发给配置的服务；只有 `allowInsecureLoopback: true` 才允许 `localhost/127.0.0.1/[::1]` 的 HTTP，可用于同机自测，不能和代理同用。`role(secret)` 只做界面遮掩，不加密存储；插件不搜索环境变量里的密钥。

### 3. `local`：用已有环境或生成部署命令

已有环境填 `mode: local`、`pythonPath`、`localModelDir`。模型要是完整的 faster-whisper/CTranslate2 目录（含 `model.bin`、`config.json`、`tokenizer.json`、`preprocessor_config.json`），不接受模型简称联网加载。

没有环境时在同页保存本机模式后点 **生成部署命令**（也可用 `video_study_setup`）。检查后手动执行才会：

1. 在状态目录建独立 `venv`，不改全局 Python、PATH 或驱动；
2. 从 PyPI 装 `yt-dlp==2026.8.19`、`faster-whisper==1.2.1`；
3. 从 `https://huggingface.co/Systran/faster-whisper-<模型>` 下载公开模型，禁用隐式 HF token；
4. 记下实际依赖版本。

状态目录默认 `~/.dsh/state/dsh-video-study`，可用 `stateDir` 改。Python 在 `venv/Scripts/python.exe`（Windows）或 `venv/bin/python`（其他系统），模型在 `models/<localModel>`。

模型约 tiny 75MB、base 145MB、small 480MB、medium 1.5GB、large-v3 3GB。命令带 `--allow-downloads` 才安装和下载；不带该参数只打印计划，不写文件也不联网。本机默认 `localDevice: cpu`、`localComputeType: int8`；CUDA 要自己确认驱动，插件不装驱动。仅字幕/云端的部署命令不装 faster-whisper 或模型。

## 常用选项

- `defaultLanguage`：默认 `auto`，可选 `en`/`zh`。已知讲英语用 `en`，中文用 `zh`。
- `forceAsr` + `reason`：字幕不可信时重识别用 `unreliable_captions`，用户主动要求用 `user_requested`；没选 ASR 后端时不允许。
- `captionsOnly`：任何模式下都禁用 ASR，不读云端密钥，不加载模型。
- `biliCookieFile` / `youtubeCookieFile`：用户明确授权的 Cookie 文件，默认空，不读浏览器。B站 Cookie 只发给 API，不发给字幕/音轨 CDN；云端不接收平台 Cookie。
- `proxy`：默认空即直连，不读系统或环境代理。显式无凭据 HTTP 代理三种模式都支持；云端和部署不支持 HTTPS 代理或 SOCKS，遇到就停止。
- 音轨只接受独立 HTTPS 直链，拒绝 HLS/分片清单、b23 短链和视频下载兜底；B站没有 CID 回显时会核验媒体路径和时长，部分合法视频可能被拒。
- 网络、429、登录、风控、字幕解析错误不算无字幕，不自动触发 ASR，也不绕过平台限制。
- `downloadTimeout` 默认 300 秒、`maxDuration` 默认 14400 秒、`asrTimeout` 默认 3600 秒；云端为本次上传/响应预算。
- 取消会终止进程树；强制终止时 Python 可能来不及清理，临时音轨可能残留。不自动删用户模型、密钥、Cookie 或历史资料。

## 输出

输出到新的绝对目录，默认系统临时目录下的随机任务子目录，可用 `outputDir` 指定绝对根目录。不覆盖已有文件。

平台字幕保留原始 VTT/SRT/JSON；ASR 保留 `raw-asr.json`、TXT、Markdown、SRT 和 `metadata.json`。元数据写来源、类型、语言、模型和警告，不写密钥或 Cookie。云端失败时音频可能已上传。

工具返回 `content_verified=false` 表示还没核对：读完全文，确认课程/分 P/首末时间和覆盖范围，再翻译整理。

## 开发与发布

```sh
node client/build.mjs
node --test
python -B scripts/test_python.py
node scripts/check-package.mjs
# 用 npm / pnpm pack 生成标准包；没有 prepare/postinstall 生命周期脚本
```

Python 测试离线跑 fixture；Node 测试含进程树取消和 SDK 注入边界。

发布前确认包名可用、补仓库信息、审核许可；可分享源码或 tgz。不要上传 stateDir、配置、输出、依赖或模型。`registerSkill: false` 时不注册随包技能（默认 true）。

## 许可

MIT，保留上游版权声明，见 [上游许可](<LICENSE-UPSTREAM>)。依赖与模型的许可证见 [第三方说明](<THIRD_PARTY_NOTICES.md>)。请只处理你有权访问和转写的内容。
