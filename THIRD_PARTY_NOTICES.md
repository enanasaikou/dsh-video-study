# 第三方来源与边界

- 前端本地二维码编码包含 `qrcode-generator@1.4.4`（Kazuhiko Arase，MIT）的未修改源码，经固定SHA256校验后打入客户端；版权许可同时保留在生成代码和[独立许可](<client/vendor/LICENSE.qrcode-generator>)中。来源、大小及锁定哈希见[依赖记录](<client/vendor/README.md>)。只用本地矩阵生成，不调用外部二维码图像服务。React和DSH SDK继续由宿主提供，不打入第二份React。
- B站扫码采用网页端登录接口而非开放平台OAuth；协议/可用性可能变化，不承诺平台永久支持。Windows加密使用系统DPAPI，不分发第三方密码库；其他平台没有安全持久化实现时仅保留内存会话。

- 字幕提取思路参考 [jagathsrujan/dsh-youtube-study-notes](https://github.com/jagathsrujan/dsh-youtube-study-notes)，原审查基准commit `a8fd6a98aa0fd19a14b763a1213c3ad8d3f5566b`；保留 [上游MIT声明](<LICENSE-UPSTREAM>)。本包的字幕/音轨/ASR实现来自用户现有独立工具及本次新增代码，不包括上游抽帧依赖或其安装脚本。
- 可选运行依赖 yt-dlp、python-docx **未随本包分发**，由用户手动安装，以各自发布的许可证、二进制依赖许可为准。不要将本包MIT误解为替代它们的许可。本云端发行版不包含本机识别引擎、模型或模型下载功能。
- DSH宿主SDK作为peer由宿主提供，不复制到本包。宿主SDK的授权和版本兼容性由其发行版决定。
- 云端ASR由用户选择的服务提供，本包不提供免费额度或服务账户；费用、音频保留/训练使用、地区和隐私条款需用户自行确认。不把“OpenAI兼容”当作所有功能都兼容或隐私合规保证。
- 下载/读取YouTube、B站内容须遵守平台条款及用户对内容的访问、使用和转写权限；本包不绕过付费、登录或风控限制。
