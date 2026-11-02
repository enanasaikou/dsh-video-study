# 变更日志

本文件记录用户可见的行为变化。安装方式见 [README](README.md)。

## 0.6.1

- 随包技能与导出工具提示改为：备注仅保留必要的“识别字幕 → 改正字幕”，不为不够全面的讲述补写长篇严谨性说明。
- 默认仅交付一个最终文档，不附送测试稿、源稿或报告；任务临时文件按明确边界清理，原始字幕和插件文件不受影响。
- 离线测试入口增加独占系统临时工作区并在正常/异常退出后清理；B站字幕测试不再强制在当前目录创建临时文件。

## 0.6.0

- 新增 `video_study_export`：将已整理课程正文导出为 DOCX / Markdown / TXT，输出位置与格式仅取已保存设置；不读取 ASR 密钥、B站会话，不上传音频。
- 设置页新增「文档输出」，与「字幕与ASR」「B站登录」组成三个独立子标签，键盘可访问，切换保留草稿；文档设置单独差量 CAS 保存。
- Word 使用原生可编辑 OMML 公式，有限 LaTeX 子集之外完整保留原式并警告；公式渲染不代替理论/原声核对。缺少 python-docx 时停止，不自动安装。
- 导出限制2 MiB输入、拒绝网络/设备/链接父链，随机新文件不覆盖；不抓取外部资源，MD/TXT无需Word依赖。

## 0.5.3

- 自建/转售网关（如 `maas.qianwenaiapi.com`）的 Qwen 文件转写可跑通：任务成功后的结果地址除阿里 OSS 地域桶外，也接受应答该任务的同一站点（同主机或子域；仍限 HTTPS、无账号口令、无端口、不跟跳转、不带 API Key）。
- 结果地址查询串按 OSS 签名规则放宽：允许标准 `response-*`、`x-oss-*` 参数与 Base64 的 `+`、`%XX`，仍拒绝未知键、重复键、控制字符和缺少签名组合。
- `failure.json` 记录 `stage`（upload_policy / upload_object / task_submit / task_poll / task_result_url / result_download / result_parse）、`shape`（字段名）与 `result_host`，便于定位失败环节；不记录服务原文、完整 URL 或任务 ID。

## 0.5.2

- `dashscope_paraformer`（阿里原生异步）协议支持 Qwen 文件转写模型：`*filetrans` 模型改用 `input.file_url` 单体提交，从 `output.result.transcription_url` 取结果，返回真实毫秒级分段，可处理长录音。
- 服务返回的结果地址是明文 `http` 时，仅在该 filetrans 通道接受并写入 warning；其它协议仍要求 HTTPS。
- 存储桶允许落在任意 `*.oss-<region>.aliyuncs.com` 地域，但结果地址地域必须与上传策略返回的地域一致。
- `*filetrans` 模型配到 `dashscope_qwen` 协议时，保存检查直接报“协议与模型不匹配”，不再等云端返回无法解读的 4xx。
- 新增预设「阿里 Qwen 文件转写（长录音）」。

## 0.5.1

- 修正更改服务目标时的凭据处理：0.5.0 在改地址/协议/AppID/地域/资源 ID 时会把已保存的 Key 一起删除，而多数厂商不提供再次查看 Key。现在只撤销上传授权、保留 Key，重新勾选授权后该 Key 才发往新地址。

## 0.5.0

- 云端 ASR 改为自定义厂商 + 显式协议：服务名、API 地址、模型、Key 全部由用户填写，协议从 `auto`、`openai`、`dashscope_paraformer`、`dashscope_qwen`、`volcengine_flash`、`tencent_rec_task` 选择。
- 新增硅基流动、Paraformer、Qwen-ASR、火山极速、腾讯录音识别与 Groq 预设按钮；预设只填表，可继续修改。
- 纯文本协议（Qwen、硅基流动）不再伪造时间戳、不生成 SRT/VTT，只输出正文。
- 火山引擎协议的音频格式不经转换不受支持时，改用本机已有的 ffmpeg 做一次本地转码（16 kHz 单声道 64 kbps MP3），不联网、不截断、不改变平台时长。

## 0.4.0

- 取消模型名称的 ASCII 命名规则与 100 字符上限，不再修剪或截断输入。
- 取消 Key 的 8 字符下限，并为保存错误标注具体字段。
- 保留控制字符校验、HTTPS 要求、请求头安全边界（Key ≤ 8192 ASCII 字符）与整次保存 64 KiB 上限——这些不是模型名称规则或转写文本字数限制。
- 新增阿里百炼 Paraformer 原生录音转写协议，不再把任意阿里模型当作 OpenAI 兼容接口。

## 0.3.1

- 修复 0.3.0 的设置读取兼容问题：模式框变灰并提示“设置服务返回格式无效”时，是旧版未成功读取配置，不是缺少模型。
