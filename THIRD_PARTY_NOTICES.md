# 第三方来源与边界

- 前端本地二维码编码包含 `qrcode-generator@1.4.4`（Kazuhiko Arase，MIT）的未修改源码，经固定SHA256校验后打入客户端；版权许可同时保留在生成代码和[独立许可](<client/vendor/LICENSE.qrcode-generator>)中。来源、大小及锁定哈希见[依赖记录](<client/vendor/README.md>)。只用本地矩阵生成，不调用外部二维码图像服务。React和DSH SDK继续由宿主提供，不打入第二份React。
- B站扫码采用网页端登录接口而非开放平台OAuth；协议/可用性可能变化，不承诺平台永久支持。Windows加密使用系统DPAPI，不分发第三方密码库；其他平台没有安全持久化实现时仅保留内存会话。

- 字幕提取思路参考 [jagathsrujan/dsh-youtube-study-notes](https://github.com/jagathsrujan/dsh-youtube-study-notes)，原审查基准commit `a8fd6a98aa0fd19a14b763a1213c3ad8d3f5566b`；保留 [上游MIT声明](<LICENSE-UPSTREAM>)。本包的字幕/音轨/ASR实现来自用户现有独立工具及本次新增代码，不包括上游抽帧依赖或其安装脚本。
- CPython、yt-dlp、python-docx、lxml 与 typing_extensions **未随本包分发**。Windows x64 / arm64 仅在用户显式点击准备/修复后，由 Node 下载 python.org 官方固定版本 CPython embeddable ZIP 与 PyPI 固定 SHA256 的 wheel；不使用系统 Python 或 pip。其他系统仍由已有 Python `3.10+` 创建 venv 安装依赖，真正自定义环境由用户自行维护。高级部署命令仍采用系统 Python 方案。
- CPython 遵循 [PSF 许可](https://docs.python.org/3/license.html)，各 wheel 及其二进制依赖遵循各自分发中的许可（例如 [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)、[python-docx](https://github.com/python-openxml/python-docx/blob/master/LICENSE)、[lxml](https://lxml.de/FAQ.html#what-is-the-license)、[typing_extensions](https://github.com/python/typing_extensions/blob/main/LICENSE)）；本包 MIT 不替代这些许可。私有环境保留下载包中的许可与元数据，不自动更新。仅省略固定 yt-dlp wheel 中经过逐项列举的五个非运行必需文档/命令行补全文件，不把这些 `.data/data/share` 文件安装到系统目录；其他 `.data` 成员仍拒绝。本云端发行版不包含本机识别引擎、模型或模型下载功能。
- DSH宿主SDK作为peer由宿主提供，不复制到本包。宿主SDK的授权和版本兼容性由其发行版决定。
- 云端ASR由用户选择的服务提供，本包不提供免费额度或服务账户；费用、音频保留/训练使用、地区和隐私条款需用户自行确认。不把“OpenAI兼容”当作所有功能都兼容或隐私合规保证。
- 下载/读取YouTube、B站内容须遵守平台条款及用户对内容的访问、使用和转写权限；本包不绕过付费、登录或风控限制。
