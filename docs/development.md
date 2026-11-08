# 开发与验证

面向修改插件源码、审查行为或制作安装包的开发者。只想使用插件，请先看[首次安装与使用](getting-started.md)。本仓库是 **0.9.1 云端稳定版**：只支持 `captions` / `cloud`，不包含本机 ASR 引擎、模型设置或模型下载。

## 代码入口

| 位置 | 职责 |
|---|---|
| [lib/index.js](../lib/index.js)、[lib/adapter.mjs](../lib/adapter.mjs) | DSH/Cordis 插件入口、配置、四个工具与技能注册 |
| [lib/runtime.mjs](../lib/runtime.mjs) | Python 调用、模式边界、提取与导出流程 |
| [lib/workspace-paths.mjs](../lib/workspace-paths.mjs) | 每次调用解析会话工作区与输出位置 |
| [lib/asr-settings.mjs](../lib/asr-settings.mjs) | 设置接口、修订号 CAS、显式环境准备 |
| [client/source.js](https://github.com/enanasaikou/dsh-video-study/blob/main/client/source.js)、[client/asr.js](https://github.com/enanasaikou/dsh-video-study/blob/main/client/asr.js)、[client/documents.js](https://github.com/enanasaikou/dsh-video-study/blob/main/client/documents.js)（仓库源码，不随运行包携带） | 三个设置子标签、独立草稿及保存逻辑 |
| [python/runner.py](../python/runner.py) | Python 任务入口与离线检查 |
| [skills/video-study/SKILL.md](../skills/video-study/SKILL.md) | 助手的档位确认、完整阅读、整理与交付规范 |

[lib/client.js](../lib/client.js) 是随包提交的预构建前端，不是单独维护的源码；请改前端源文件后重新构建。插件使用的 DSH SDK 服务由宿主提供，不把宿主私有路径、会话或配置拷入包中。

## 工具 API：哪些会产生动作

| 工具 | 关键参数 | 边界 |
|---|---|---|
| `video_study_status()` | 无 | 离线检查 Python、依赖和静态配置；不联网，不验证云服务或 Key |
| `video_study_extract(...)` | 必填 `target`、`outputStyle`；可选 `language`、`captionsOnly`、`forceAsr`、`reason` | 字幕优先；只在已配置 cloud 且授权上传的边界内识别，参数不能切换模式 |
| `video_study_setup(backend?)` | `captions` / `cloud` | 只生成用户可检查的部署命令，不执行安装、不改配置 |
| `video_study_export(...)` | 必填 `title`、`markdown`；可选 `sourceUrl` | 仅离线转换已整理正文；格式与目录读取设置，不执行 ASR 或自动译写 |

`outputStyle` 只能是 `verbatim` / `concise` / `summary`，须来自用户**本次**选择；它不裁剪原始素材。B站 `target` 保留分 P。素材成功结果中的 `metadata_file`、`transcript_file` 供助手完整读取；导出成功后交付 `document_file`，而不是再附一套中间稿。

`captionsOnly: true` 禁止 ASR；`captions` 模式不允许 `forceAsr`。网络、限流、登录及解析错误不得冒充缺字幕，不能借此触发上传。Word 的 OMML 转换不构成公式验证；未支持的 LaTeX 保留并告警。详细定义以[工具声明](../lib/adapter.mjs)与[随包技能](../skills/video-study/SKILL.md)为准。

## 本地测试与构建

开发测试需要 Node `>=22.19.0`；运行 Python unittest 还需可用的 Python `>=3.10`。这不是 Windows 最终用户主按钮的前置条件：该按钮通过 Node 下载固定版本官方 CPython embeddable ZIP 和固定哈希 wheel；其他系统主按钮仍需已有 Python 来创建 venv。高级生成命令也继续采用系统 Python 方案。测试采用 Node 内置 test runner 和 Python unittest；常规源码检查无需为了打包先安装 npm 依赖。以下命令均在仓库根目录运行：

```sh
# 改前端后先更新预构建产物
node client/build.mjs

# 离线回归
node --test
python -B scripts/test_python.py

# 核对包内容、版本约定、前端产物及文档本地链接
node scripts/check-package.mjs
node scripts/check-docs.mjs
```

若只迭代设置页，可先运行更小的 VM 回归：

```sh
node --test tests/asr-client.test.mjs tests/document-client.test.mjs tests/client.test.mjs
```

测试使用伪网络、fake React/VM、离线素材和模拟宿主；**测试通过不代表真实 GUI、扫码、代理、付费账号或所有云服务已经验收**。Python 测试入口会建立独占临时目录并阻止真实网络；不要把临时目录指向源码根目录，也不要为测试填入真实 Key、Cookie 或账号数据。

提交前检查新增文件及差异，避免将日志、配置、凭据、课程素材、虚拟环境和临时输出混入提交。需要真实服务验证时，另行明确授权和计费范围，不扩展离线测试的默认权限。

## 制作 TGZ

```sh
npm pack --ignore-scripts
```

命令在当前目录生成带版本的 TGZ，**不会安装到 DSH**。发行内容由 [package.json](../package.json) 的 `files` 决定；提交的预构建界面必须与前端源码一致。检查器会拒绝模型、二进制安装器、机器私有路径和不应分发的运行状态；可用下面命令只检查打包清单：

```sh
npm pack --dry-run --ignore-scripts
```

不要因为包名存在于源码就写 `npm install dsh-video-study`，也不要因为本地有 TGZ 就声称 GitHub Release 已上传。对外安装入口应是维护者确实交付的包，或[从源码打包](getting-started.md#1-安装插件)。发布及上传需另行执行并核验，不能以打包成功代替。

## 修改时保留的约定

- **配置与凭据分离**：前端只读“是否已配置 Key”，不读回 Key；文档页只保存目录和格式，不夹带 ASR 字段或上传授权。修订号冲突保留草稿，须明确重新载入，不自动重试覆盖。
- **路径分层**：托管 Python 在宿主状态目录；任务素材默认在当前会话工作区的 `video-study/transcripts`，最终文档在 `video-study/documents`。不要回退到进程启动目录、用户目录或系统临时目录保存任务产物。
- **动作须显式**：打开设置、状态检查和普通任务不安装；切换标签不上传、不保存。“一键准备/修复运行环境”仅用户显式点击才联网下载，不自动更新；“生成部署命令”本身不执行。
- **Windows 托管隔离**：在状态目录 `runtimes` 使用版本唯一目录；固定 `_pth` 含完整标准库、运行时目录与 `packages`，不加载用户 site，不用系统 Python/pip/venv。验证后才切换指针；失败保留旧运行时与旧 venv，需用户重试。Python 路径留空自动选择新托管环境，不保存版本绝对路径；同状态目录旧托管路径兼容，真正自定义路径不覆盖。
- **证据边界**：fixture 可以覆盖下载白名单、哈希、解包与切换失败等行为，但不等于官方包实际下载、Windows 全流程或真实课程任务已验收；未执行就不要宣称端到端成功。
- **发行边界**：不要从其它分支整包覆盖回补，不引入本机模型功能。文档整理不需要发新版；真正变更版本时，同步包元数据、说明与版本检查，不虚构发布结果。

安全问题请按[安全说明](../SECURITY.md)处理；使用层面的云服务与排障见[云服务配置](cloud-services.md)和[故障排查](troubleshooting.md)。
