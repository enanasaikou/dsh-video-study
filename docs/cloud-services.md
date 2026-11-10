# 配置云端语音识别

适用于本仓库的 **captions / cloud 稳定版**，不包含本地 ASR。已有字幕始终优先；云端模式只在没有字幕或没有目标语言字幕时接续识别。网络、权限和字幕读取错误不会被当成“无字幕”。主动重识别需本次明确要求。

## 先在界面完成这几步

1. 打开 **DSH 设置 → 视频学习 → 字幕与ASR**，模式选“云端ASR”。
2. 填“接口协议”“API地址”“模型 / 引擎参数”和该协议的凭据。**服务名称（自定义）只是备注，不决定协议**。
3. 确认服务商、计费与音频隐私条款，再勾选“允许上传音频到此服务（可能产生费用）”，点“保存设置”。更改地址、协议、应用/凭据标识、地域或资源ID会撤销上传勾选，需重新确认；已保存的 Key 不会随之清除，换服务时也要检查 Key。
4. 尚未准备 Python 依赖时，保存后由你显式点击“一键准备/修复运行环境”才联网：Windows 下载固定版本官方私有 CPython 与固定哈希依赖，无需系统 Python 或 pip；其他系统仍需已有 Python `3.10+` 来创建 venv。准备 yt-dlp、python-docx，不安装 ASR 模型或 ffmpeg，不自动更新；失败保留旧环境，需手动重试。Python 路径留空自动选择已准备的托管环境，真正自定义解释器不改动。“检查环境”仅离线检查，**不验证余额、Key有效性、网络或真实识别效果**。
5. 每次提取前，告诉助手本次要“原文（完全复述）/ 简要压缩 / 总结”。输出详略只影响最终正文，不删减原始转写材料。

Key 输入框留空表示保留已保存值；删除要勾“清除已保存的Key”再保存。不要把 Key 放进 API 地址、截图、仓库或聊天。高级设置的“Key文件（可选）”是本机绝对路径；仅在没有已保存 Key 时使用，不自动读取环境变量中的凭据。

## 按协议填，不按品牌猜

下表是**字段填写示例，不是预置菜单或真实账号验收记录**。模型、地域、资源和权限以你账户当前开通的产品为准；第三方“兼容 OpenAI”不代表支持所有音频模型或返回格式。

| 界面协议 / 配置值 | API地址示例（完整接口，不是控制台网址） | 模型 / 引擎参数示例 | 其他必填项 |
| --- | --- | --- | --- |
| 通用 / OpenAI兼容 / `openai` | `https://api.openai.com/v1/audio/transcriptions` | `whisper-1` | API Key |
| 阿里 / 录音文件转写 / `dashscope_paraformer` | `https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription` | `paraformer-v2` | API Key |
| 阿里 / Qwen短音频 / `dashscope_qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen3-asr-flash` | API Key |
| 火山 / 豆包录音转写 / `volcengine_flash` | `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` | `bigmodel` | App ID、Access Token、语音资源ID（如账户开通的 `volc.bigasr.auc_turbo`） |
| 腾讯 / 录音文件转写 / `tencent_rec_task` | `https://asr.tencentcloudapi.com/` | `16k_zh` | SecretId、SecretKey；地域可留空或填账户适用值（如 `ap-guangzhou`） |

阿里北京地域也可按官方要求，把示例域名替换为你自己的 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，保留后面的完整路径；不要把花括号占位符直接填入。国际站须使用对应地域域名和该地域 Key，不能只换 Key 而保留错误地址。

“旧配置兼容（非自动识别）”用于旧配置，不会自动识别任意厂商协议；新配置建议明确选择协议。界面随选择显示用途、完整接口和模型占位示例，但不会自动填入地址、模型或凭据，也不会因此发起请求。原生协议会构造各厂商专用的 JSON、签名、上传和轮询流程；OpenAI兼容协议则发送 multipart 文件转写请求，不能代替这些原生流程。

### 第一次配置：OpenAI 文件转写示例

如果你使用的是 **OpenAI 官方音频转写服务**，可在设置页逐项这样填写；这是字段示范，不是免费服务或本项目实测账号承诺：

| 设置项 | 填写内容 |
| --- | --- |
| 模式 | 云端ASR |
| 服务名称 | 任意便于自己识别的备注，例如“OpenAI 音频转写” |
| 接口协议 | 通用 / OpenAI兼容 |
| API地址 | `https://api.openai.com/v1/audio/transcriptions` |
| 模型 / 引擎参数 | `whisper-1` |
| 响应请求格式 | `verbose_json` |
| API Key | 在页面的 Key 输入框单独填写自己的 Key，不贴到聊天或仓库 |
| 上传授权 | 确认目标、隐私和费用后再勾选，并保存 |

这里的 `whisper-1` 是云服务模型名，不是在本机安装 Whisper。若使用第三方兼容服务，地址、模型和响应格式必须改成该服务实际支持的值；不要照抄品牌名猜协议。当前页面不提供 JSON 配置文件导入。

所有协议都要求填写模型 / 引擎参数，即使不是传统模型名称。模型允许 Unicode 和空格，但不得含控制字符或无效 Unicode；设置请求总量有限制，不会截断模型名来凑合法值。

## 各协议实际边界

- **OpenAI兼容**：“响应请求格式”可选 `verbose_json`、`json` 或 `provider_default`。服务不接受扩展参数时可选“服务默认（只传文件和模型）”；它不发送语言/时间戳等提示。只有返回受支持的有效 JSON 正文才可继续；不兼容任意聊天/流式接口。真实分段才生成 SRT；只有全文时保留全文，不猜时间戳。
- **阿里 / 录音文件转写**：插件申请临时上传凭证、上传音轨、提交任务并轮询结果。`paraformer-v2` 和 `qwen3-asr-flash-filetrans` 等 **filetrans** 模型都选此项，使用 `/api/v1/services/audio/asr/transcription` 路径，而不是 Qwen短音频项。filetrans 返回官方 OSS HTTP 结果链接时，完整校验后只以同主机 HTTPS:443 读取，保留原签名路径与查询串；不发明文请求，不接受网关 HTTP，不在 TLS 失败后降级或重试。临时对象存储上传不等于纯本机处理；官方不建议将临时上传方案用于生产、高并发或压测。
- **阿里 / Qwen短音频**：发送内联 Base64 Data URI 音频，当前接收纯文本识别结果，不产出 SRT。编码后音频连同 Data URI 前缀不得超过 **10,000,000 字节**，所以不能把“最大音频MiB”当作唯一限制；不支持在这里换填 filetrans 模型。
- **火山 / 豆包**：当前使用 App ID + Access Token + 资源ID 的极速版接口，不支持把新式单一 API Key 当作 Access Token 的自动替代。音频最多 **100,000,000 字节、2小时**，还受你设置的更小限额约束。wav/mp3/ogg/opus 直接发送；其他已支持容器需要 PATH 上已有的 ffmpeg 转换，插件不会自动安装 ffmpeg。
- **腾讯云**：使用 TC3 签名、`CreateRecTask` 和 `DescribeTaskStatus`，仅实现内联音频，原始音频最多 **5,000,000 字节**。官方 URL 音频的大文件额度不适用于此实现。需要真实分段时间戳；已知不提供相应时间戳的引擎会被拒绝。

没有自动分块、转向其他服务、失败后重传或凭据回退。失败任务也可能已产生费用，重试前先在服务商控制台确认。

## 地址、代理与限额

- 远程 API 使用 HTTPS；地址不得带用户名密码、查询参数、片段或路径穿越。自定义完整接口路径不等于兼容任意协议。
- 字幕下载、B站扫码登录与云端ASR共用设置里保存的这一个代理，仅支持显式、无认证的 `http://host:port`，例如 `http://127.0.0.1:7897`。这是本机代理的地址示例，请按实际端口修改；留空不使用插件显式代理，示例不自动填入。不支持 HTTPS/SOCKS 代理，不得带账号密码、业务路径或查询串，不继承系统环境代理。远程 HTTPS 经 HTTP CONNECT 代理后仍使用 TLS，并不因此改成明文 API；代理连接失败会如实报错，不降级直连。
- “允许本机回环HTTP服务”只用于 OpenAI兼容协议的 `localhost` / `127.0.0.1` / `::1` 本机服务，且不能与代理同时用，不是放行远程 HTTP 的开关。
- 默认最大音频 **25 MiB**、下载超时 **300秒**、转写超时 **3600秒**、最长音频 **14400秒**。高级设置可调整；最大值分别为 512 MiB、3600秒、86400秒、86400秒。同步识别等待响应时使用 ASR 总预算的剩余时间，不再额外截断为30秒；上传、等待响应头和读取正文共用预算，连接和上传仍保留短时网络超时。服务商/协议更小的上限仍优先，本机超时不保证服务端任务被取消，也不会自动重传。

## 官方参考与验证范围

- [OpenAI 文件转写 API](https://platform.openai.com/docs/api-reference/audio/createTranscription)
- [阿里 Paraformer 异步 HTTP API](https://www.alibabacloud.com/help/en/model-studio/paraformer-recorded-speech-recognition-restful-api)
- [阿里 Qwen-ASR API（聊天与 filetrans 的区别）](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference)
- [火山录音文件极速版 HTTP 接口](https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-lite-recognition-api?lang=en)
- [腾讯云 CreateRecTask](https://cloud.tencent.com/document/api/1093/37823) · [DescribeTaskStatus](https://cloud.tencent.com/document/api/1093/37822) · [TC3签名](https://cloud.tencent.com/document/api/1093/35641)

离线 mock/fixture 测试只验证请求结构、解析与安全边界，不证明真实账户、所有地区、所有模型或全部兼容服务已经实测。先用你有权上传的短音频确认服务可用，再处理课程；识别成功也不等于正文、语言和全文覆盖已校对。遇到问题见[常见问题](troubleshooting.md)，回到[首页](../README.md)。
