# 从安装到第一份课程文档

本插件运行在 **DeepSeek Harness（DSH）** 中，不是独立的视频下载器。DSH 提供对话助手、工具和插件设置；请先从[宿主官方仓库](https://github.com/deepseek-ai/deepseek-harness)了解并安装宿主。

## 1. 安装插件

- 宿主兼容范围：DSH `>=0.2.1-rc.5 <0.3.0`，Node `>=22.19.0`。
- **Windows x64 / arm64**：主按钮可准备插件私有 Python，无需先装系统 Python。**其他系统**：仍需先有本机 Python **3.10 或更新版本**，按钮在此基础上创建 venv。宿主与 Node 仍需自行准备。
- 只处理你有权访问和使用的视频。第一次建议选一段**已有字幕的短视频**，先跑通默认字幕模式，不必配置云服务。

### 通过 DSH 安装（推荐）

插件已发布到 npm。在已配置好 `dsh` 命令的终端执行，安装到 `web` profile：

```sh
dsh plugin --profile web add dsh-video-study@0.9.1
```

这是 DSH 插件管理命令，不是直接执行 `npm install dsh-video-study`。若已有同名插件，安装会更新或替换该 profile 中的插件；请先确认目标 profile。宿主和 Node 不由插件安装。

### 使用 TGZ 或从源码打包

若终端找不到 `dsh` 命令，或需要本地包安装，可从 [GitHub 0.9.1 Release](https://github.com/enanasaikou/dsh-video-study/releases/tag/v0.9.1) 下载可信的 `dsh-video-study-0.9.1.tgz`，交给 DSH 插件管理安装；也可安装 Git、Node/npm 后，从源码自行打包：

```sh
git clone https://github.com/enanasaikou/dsh-video-study.git
cd dsh-video-study
npm pack --ignore-scripts
```

命令会在当前目录生成 `dsh-video-study-<版本>.tgz`，实际文件名以命令输出为准。仓库已跟踪预构建设置界面，**这条安装路径不需要先运行 `npm install` 或构建**。打包本身不安装插件，也不准备 Python 环境。

将该 TGZ 的**实际绝对路径**交给 DSH 插件管理安装。也可在 DSH 对话中说明：

> 请通过插件管理安装我提供的本地 TGZ：`这里替换为实际绝对路径`。先确认包名和来源；若已有 dsh-video-study，请明确提示将替换同名插件，等我确认后再安装。

安装完成后完整重载 DSH。打开 **设置 → 视频学习**，应看到 **字幕与ASR / 文档输出 / B站登录** 三个标签；对话中应可使用 `video_study_status` 等工具。若没有出现，先检查插件是否启用、宿主版本是否兼容，再重载，不要反复安装。

## 2. 点一下准备运行环境

1. 在 **字幕与ASR** 选择默认的 **仅字幕（captions）**，保存设置。
2. 首次使用将高级设置中的 Python 路径留空，点击 **一键准备/修复运行环境**。只有这次显式点击会联网下载运行环境，打开设置和检查状态不会安装。
3. **Windows x64 / arm64**：Node 从 python.org 下载固定版本官方 CPython embeddable ZIP，从 PyPI 下载固定哈希 wheel，在插件状态目录的 `runtimes` 下建立版本唯一的私有环境。含完整标准库、`yt-dlp`（YouTube 字幕）、`python-docx`（Word 导出）及其所需依赖，不用系统 Python、pip 或 venv；固定 `_pth` 加载私有 `packages`，不加载用户 site。**其他系统**：使用已有 Python `3.10+` 创建独立 venv。均不修改系统 Python / 全局 PATH，不下载 ASR 模型或 ffmpeg，不自动更新。
4. 等待单行进度结束，再点 **检查环境**。成功标志是依赖齐全、显示 **环境可用**。Python 路径保持留空，自动选择已准备的新托管环境，不写死版本路径；同一状态目录的旧托管 venv 路径仍兼容。真正自定义解释器不改动，检查将使用它。

**环境可用只表示离线检查通过**，不代表已验证 API Key、云服务连通性或实际转写。Windows 准备/修复失败会保留旧环境、旧 venv、任务与配置，按提示检查网络、磁盘等问题后手动重试；其他系统缺 Python 时先自行准备 Python `3.10+`。真正自定义环境需自行维护依赖。不要把失败提示当作已经安装成功。

“生成部署命令”仍是**高级系统 Python + venv 方案**，需要本机 Python `3.10+`，只生成供你检查和手动执行的文本，不执行下载；它不是 Windows 主按钮的私有 CPython 下载方案。

## 3. 选好文档格式与位置

在 **文档输出** 选择并保存 `docx`（Word，默认）、`md` 或 `txt`。

- 目录留空：最终文件写入**当前会话工作区**的 `video-study/documents`；原始字幕与转写另存于 `video-study/transcripts`。
- 自填目录：使用**运行 DSH 服务的本机绝对路径**，不是浏览器下载目录。远程运行 DSH 时，文件也在远程机器上。
- 没有会话工作区时，先设置工作区，或明确填写所需绝对目录；不可写时停止，不偷偷换目录。

Word 需要 `python-docx`。可编辑 OMML 公式只覆盖有限 LaTeX；不支持的语法会原样保留并警告，格式转换成功不等于公式已经核实。

## 4. 给助手一个明确任务

下面使用公开的[线性代数系列](https://www.bilibili.com/video/BV1ys411472E/)作为链接示例，也可替换成你的课程。示例不保证平台当前提供可访问字幕；B站分 P 链接务必保留 `?p=2` 等参数，不能只给系列首页。

> 请用 video-study 处理 https://www.bilibili.com/video/BV1ys411472E/?p=2 的第 2 P。本次选择 **原文（完全复述）**，只取现有字幕，不调用云端 ASR。通读完整材料后按原顺序整理中文正文，保留推导和例子，导出设置中的一个最终文件。

YouTube 示例：

> 请用 video-study 处理 https://www.youtube.com/watch?v=kjBOesZCoqc 。本次选择 **简要压缩**，保留主线、关键公式、条件与代表例子，只用已有字幕，最后导出一个文件。

总结示例：

> 请用 video-study 处理 https://www.bilibili.com/video/BV1ys411472E/?p=2 。本次选择 **总结**，只取现有字幕。正文显著标明“总结”，提炼要点而不冒充完整复述，最后导出设置中的一个文件。

这三档只改变最终正文详略，原始素材仍完整提取；未在本次任务明确选择时，助手应先询问，不能沿用上次选择。工具取得素材后，助手还需通读、整理正文，再调用离线导出工具，**不是把原始字幕直接当作讲义**。

完成标志：助手展示了可打开的最终文件，内容范围与所选分 P、详略相符。打开文档检查术语、公式和警告；仅出现字幕路径或“提取成功”还不等于讲义已经完成。

## 5. 遇到这些情况怎么办

| 情况 | 下一步 |
|---|---|
| 确实没有源语言字幕 | 默认字幕模式会停止；需要识别时再自行配置 cloud 模式，并明确授权上传，可能收费 |
| B站要求登录 | 到 **B站登录** 扫码并用手机确认；不要把 Cookie 或密码发到聊天里 |
| 网络错误、限流、登录或风控失败 | 检查网络、HTTP 代理或登录状态；这些错误不是“无字幕”，不会自动转付费 ASR |
| 缺少 `python-docx` | 使用设置页准备环境或修复实际使用的解释器；临时改为 MD/TXT 需你自己保存格式设置 |
| 设置冲突 | 草稿仍在；先核对，再明确重新载入，不盲目重复保存 |

云端地址、协议和密钥只在设置中填写，勾选上传授权后才允许使用。不要在示例提示词里写 Key。继续阅读：[云服务配置](cloud-services.md) · [高级设置](advanced.md) · [故障排查](troubleshooting.md) · [成稿示例](examples/lesson-output.md) · [安全说明](../SECURITY.md) · [开发指南](development.md)。
