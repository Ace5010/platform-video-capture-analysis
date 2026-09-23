# AGENTS.md

# 1. 项目简介

这是一个在 Windows 本机运行的抖音对标账号信息抓取与分析工具。

主要功能：

- 由电脑后台通过 Playwright Core 控制专用 Chrome，抓取公开抖音账号和视频数据；电脑和手机都不需要扩展。
- 保存账号、视频、互动快照、口播稿和 AI 分析结果。
- 使用云端 `qwen3-asr-flash-filetrans` 识别目标视频的完整音轨，已有完成的同视频口播稿直接复用。
- 用户主动点击后，获取完整视频，优先选用平台已有的 1080p 源，连同口播稿交给阿里云百炼 `qwen3.8-flash` 分析。
- `local_asr/` 的本地 faster-whisper 保留兼容入口，不用于视频分析默认流程，也不在云端失败后自动回退到本地识别。现有标点规范化继续保留，不改动识别文字。
- 允许同一局域网内的其他设备访问工作台并提交任务。
- 用户已要求通过 Cloudflare 网站远程使用电脑后台。远程访问使用 Workers VPC 与专用隧道，复用原有密码、CSRF、数据库和任务队列；电脑仍须开机。连接配置和实际联网验收未完成前不得声称远程功能已可用。

目前抖音功能已经实现；小红书、哔哩哔哩和 YouTube 只有预留入口，尚未实现。采集由用户手动触发，没有定时自动采集。

# 2. Agent 工作原则

- 优先修改现有代码，不要重复创建已有能力。
- 不要擅自重构现有架构或大范围改写代码。
- 不要擅自新增功能、平台、依赖或开发工具。
- 不要为了局部问题改变无关模块。
- 重大架构调整、数据结构重做、技术栈替换或行为改变，必须先询问用户。
- 如果发现文档和代码不一致，先核对当前实现，不要凭空猜测。

## 网页设计与文案规范

- 网页中的文字、字段、标签和装饰元素必须有明确用途，能帮助用户理解信息或完成操作。
- 除非用户本人明确要求，否则不得添加或保留意义不明、仅为装饰或填充版面的内容，例如无实际用途的英文标题、英文副标题、字母缩写、编号或标语。
- 非必要的小字说明、角标和装饰性文字默认不添加、不保留；确有必要的信息必须使用清晰可读的字号，不得为了视觉效果刻意缩小。
- 设计或修改网页时，检查本次涉及的区域：无法说明实际用途的内容应省略或移除，不要为了显得丰富而堆砌元素。

## Git 提交规范

- Commit Message 必须使用简体中文，清楚说明本次修改的实际目的。
- 避免含糊或只有技术动作、无法体现修改目的的描述。
- 推荐格式：`功能：新增 XXX`、`修复：解决 XXX 问题`、`优化：改善 XXX`、`重构：重构 XXX 模块`、`文档：更新 XXX 文档`、`配置：调整 XXX 配置`。
- 每个 Commit 应尽量对应一个明确、完整的修改节点，不要把互不相关的改动混在一起。

# 3. 不可破坏的规则

## API Key

- Qwen API Key 只能在主机 localhost 页面录入。
- API Key 必须使用 Windows 当前用户 DPAPI 加密保存。
- 不得把 API Key 写入源码、Git、SQLite、localStorage、URL、普通日志或测试文件。

## 数据库

- SQLite 是账号、视频、互动快照、任务、口播稿和 AI 分析的主数据源。
- 不得删除、覆盖或清空用户数据库。
- 数据库结构变更必须兼容已有数据，使用现有迁移方式。
- 保留账号 ID、视频 ID 和事件 ID 的去重与幂等逻辑。
- 当前默认数据目录是 `data/host-service/`，也可由环境变量覆盖。

## 视频处理

- AI 分析必须使用经过视频 ID 校验的目标完整视频。按用户最新要求，优先选择约 1080p、足够辨认画面与字幕的已有媒体源，不再追求 4K；没有合适源时选择最接近的可用清晰度。
- 不得用关键帧、OCR 或仅口播稿代替完整视频。优先选择平台已有编码，不额外转码压缩；模型采样预算应兼顾辨认能力与分析耗时。
- 视频与音频分离时使用 FFmpeg stream copy 无损封装。
- 云端口播识别必须使用已校验目标视频的完整音轨，并与视频上传准备并行；已有完成的同视频口播稿应直接复用，避免重复转写计费。
- 视频分析保留 `qwen3.8-flash` 的严格结构化输出校验。独立云端转写的按秒用量与视频模型的 Token 用量分别记录，成功、失败和重试均不得遗漏已发生的云端费用。
- 超过服务限制时只能按现有逻辑无损分段。
- 临时媒体必须在成功、失败或重试结束后清理。
- 标点恢复只能增加或规范标点，不能修改、删减或调整识别文字顺序。

## 端口与网络

- 当前默认端口：工作台 `3000`、主机服务 `43129`、本地转写兼容端口 `43128`。
- 除非任务明确要求，否则不得修改这些端口。
- 修改端口时，必须同步检查相关认证来源、Cookie、扩展白名单、局域网访问配置、启动脚本、文档和测试。
- 不得把原有服务端口直接开放到公用网络或互联网。已授权的 Cloudflare 远程接入仅连接 `127.0.0.1:43130` 受限入口，不做路由器端口映射，不把 `43129` 作为 VPC 目标。
- 远程入口仅监听回环地址，由账号内私有 VPC Service 连接；验证正式网站来源并保留密码会话及 CSRF，始终视为非本机。不得允许远程设置密码、修改 Qwen Key、迁移旧数据、打开登录窗口或调用扩展接口。隧道凭据使用独立 DPAPI 文件，不配置公网后台域名或公共隧道路由。

## 通常不应直接修改的目录与文件

- `node_modules/`
- `.venv/`
- `.next/`
- `.vinext/`
- `.wrangler/`
- `dist/`
- `data/`
- `__pycache__/`
- `*.tsbuildinfo`

这些目录包含依赖、缓存、构建产物或用户运行数据。除非任务明确要求，否则不要删除、移动或直接编辑。

# 4. 修改后的检查

- 根据修改范围运行最相关的测试，不要机械执行全部检查。
- 涉及功能逻辑的修改，必须运行对应测试。
- 涉及构建、依赖、类型或跨模块修改时，运行 `npm run lint` 和/或 `npm run build`。
- 仅修改文案、注释或文档等不影响运行逻辑的内容，无需完整构建。

测试对应关系：

- 前端互动数据计算：`npm run test:video-analytics`
- 分析用量与费用展示：`npm run test:analysis-usage`
- 工作台与扩展桥接：`npm run test:bridge`
- 后台 API、认证、SQLite、任务队列或 AI 分析流程：`npm run test:host`
- 云端口播识别及其与视频分析的并行流程：`npm run test:host`
- 本地口播兼容入口或标点恢复：`npm run test:asr`
- 扩展任务调度、锁或多账号执行：`npm run test:scheduler`
- 扩展与主机连接、鉴权、队列或媒体选择：`npm run test:connector`
- 扩展版本或能力要求：`npm run test:extension-compatibility`

专用浏览器复用 `chrome-extension/background.js` 内的采集函数，每个任务重新加载；生产模式已禁用旧扩展接口。修改采集函数后无需刷新扩展；修改 `scripts/browser-worker.mjs` 或 Python 后台后需安全重启主机服务。浏览器驱动和队列改动运行 `npm run test:browser`。不要声称测试通过，除非实际运行过对应命令。

# 5. 项目地图

- 前端：`app/`
  - 主页面：`app/page.tsx`
  - 全局样式：`app/globals.css`
- 前端共享逻辑：`lib/`
- 后台：`host_service/`
  - 专用浏览器队列：`host_service/browser.py`
  - 浏览器驱动：`scripts/browser-worker.mjs`
  - API：`host_service/server.py`
  - 配置：`host_service/config.py`
  - Cloudflare 隧道进程与加密连接配置：`host_service/remote.py`
- Cloudflare HTTPS 网关：`app/host/[...path]/route.ts`、`lib/host-proxy.ts`
- 非秘密部署绑定：`cloudflare-host.json`；不要在此填写任何 token 或 API Key。
- Chrome 扩展：`chrome-extension/`
  - 主要逻辑：`chrome-extension/background.js`
  - 扩展配置：`chrome-extension/manifest.json`
- AI 分析：
  - 分析流程：`host_service/analysis.py`
  - Qwen 调用：`host_service/qwen.py`
  - 媒体处理：`host_service/media.py`
  - 本地口播识别兼容入口：`local_asr/`
- 数据库：`host_service/database.py`
- 启动和测试脚本：`scripts/`

# 6. 技术参考

## 技术栈

- Windows / PowerShell
- Node.js / npm
- React / Next.js / TypeScript
- Vinext / Vite
- Python / SQLite
- faster-whisper / sherpa-onnx（本地兼容入口）
- Chrome Manifest V3
- FFmpeg / ffprobe
- 阿里云百炼 `qwen3.8-flash` 视频分析 / `qwen3-asr-flash-filetrans` 云端口播识别

具体版本以 `package.json`、`package-lock.json`、`requirements-asr.txt`、`chrome-extension/manifest.json` 及对应配置文件为准。

## 安装与运行

```powershell
npm install
npm run setup:asr
npm run dev
```

- 工作台：`http://localhost:3000`
- 主机健康检查：`http://127.0.0.1:43129/health`

只启动网页：`npm run dev:web`

构建与启动：

```powershell
npm run build
npm run start
```

## 详细技术约束

- 使用 npm 和现有 `package-lock.json`，不要擅自更换包管理器。
- TypeScript 已启用严格模式，不要关闭类型检查。
- 保持现有中文界面和 CSS 变量、类名体系。
- 可独立测试的前端计算逻辑放在 `lib/`。
- 主数据保存在 SQLite，不要重新迁回 localStorage。
- 自动测试不得使用真实 API Key、真实 Qwen 调用或生产数据库。
- 修改扩展版本时，同步核对 `package.json`、`package-lock.json`、`chrome-extension/manifest.json`、`host_service/__init__.py`、`lib/extension-compatibility.ts` 和 `host_service/compatibility.py`。
- 项目包含 Sites/Vinext/Cloudflare 构建配置，但不要在用户未要求时擅自部署。
