# 变更日志

本文件记录用户可见的行为变化。安装方式见 [README](README.md)。

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
