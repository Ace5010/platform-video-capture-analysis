# Observe 微信模块接入

统一入口：`http://localhost:3000/`。顶部切换内容情报台与微信读取；微信默认进入聊天总结，聊天原文、日期/成员/关键词筛选、上下文核对、读取管理均在同一应用内。

## 代码与运行

- `app/wechat-workspace.tsx` / `.css`：原生 React 微信工作区；无 iframe、无 ChatLab 整站嵌入。
- `lib/observe-navigation.ts`：模块与内部入口恢复。地址栏和 localStorage 仅持久化模块/入口，不持久化群名、正文、搜索词。
- `host_service/wechat/`：从已验证的微信项目接入归档校验、完整话题讨论、总结规范、CodeBuddy 生成与读取任务。`vendor/` 保留固定版本校验及许可证。
- `/api/wechat/*`：与视频共用主机服务，沿用密码会话和 CSRF。正式 HTTPS 工作台通过原有私有通道开放已归档的群列表、日期、总结、完整讨论和原文筛选；未登录、其他来源及直接局域网访问不能读取微信归档。管理记录、读取聊天和付费生成继续在打开归档前检查电脑 localhost 权限。
- 手机与电脑读取同一份归档，不创建云端数据副本。远程群列表排除账号标识、批次和任务记录；正文接口使用 `private, no-store`，不嵌入静态页面或写入浏览器持久存储。筛选仅通过带 CSRF 的 POST 查询，消息按文本渲染，不执行消息中的 HTML。共享 `/api/state` 和匿名静态页面继续不含微信内容。
- 原有 `scripts/launch.ps1` 即可启动全部工作台。无需 3110 或 3113 服务。

## 数据和依赖

本次没有重建数据库或搬迁私人数据。视频继续使用 `data/host-service/monitor.sqlite3`；微信继续使用 `D:\vibe项目\WeChat-Reader\private`，包括原始归档、ChatLab 数据库、总结版本、模型回执和费用记录。

原有固定版本 ChatLab CLI、CodeBuddy CLI 安装分别复用 `WeChat-Reader/runtime` 与 `WeChat-Reader/buddy-runtime`。它们是本机依赖，不是独立网站。读取子进程使用已有全局 Python（已安装 cryptography 与 zstandard）；Observer 主机不安装或加载这些扫描依赖。

可选环境配置：`OBSERVE_WECHAT_DATA_DIR` 指定归档根目录，`OBSERVE_WECHAT_RUNTIME_ROOT` 指定上述 CLI 所在目录，`OBSERVE_WECHAT_PYTHON` 指定读取用 Python。当前配置继续复用原有已指定账号与群；页面不扩展账号授权范围。

旧项目 `scripts/launch-reader.ps1`、`serve.ps1`、`read-once.ps1` 已转到 Observe；旧启动脚本备份位于 `scripts/before-observe/`。保留旧源码以便回退，不再作为日常入口运行。

## 行为约定

- 打开页面、筛选、刷新已保存记录均不扫描微信、不调用模型。真实读取/导入和生成总结需要用户在所属模块确认目标与范围。
- 默认总结方式仍为 CodeBuddy 的 DeepSeek-V4.1-Flash high。保留 GLM low 与 Hy4 high；规范固定为先读全天、整合话题、标记群友、保留少量原话与完整讨论归属。
- 总结费用使用原始回执，保留旧结果；后台完成后提示查看，不自动重置当前阅读。
- 新版总结自动忽略旧版展示字段（今日重点、要点、单列观点、细节和结论），原始模型输出保留在执行记录中；消息覆盖、引用、原话与人物归属仍须完整通过校验。失败原因、执行阶段及已记录积分会保存并传给页面，不自动付费重试。
- 生成时使用本次任务内的短消息编号，映射另存于私有执行目录，不改变归档 ID 或来源指纹。发布前自动修复可唯一核实的长编号尾部错误、引用列表格式、已声明证据与明确回复链的讨论归属；失真的可选引语移除，正文和完整讨论保留。修复记录写入原回执，再执行完整校验；已知跨日编号、有歧义的匹配和无依据的消息归属不自动猜测，不追加模型调用。
- 话题目录和正文独立滚动；每个话题保存位置。模块切换保留两边会话状态；视频暂停并撤下媒体地址，回来保持暂停和进度。
- 微信原文按当前归档查询；“查看前后文”返回原群前后各 15 条，解除成员/关键词筛选以便核对上下文；话题“完整讨论”返回全部归属消息及相关引用链。
- 读取任务区分运行、不完整、已保存待导入、导入完成、失败和状态待核实。已提交任务不因模块切换而取消。

## 验证入口

```powershell
python -X utf8 -m unittest discover -s scripts/wechat_tests -v
node --experimental-strip-types scripts/test-observe-navigation.ts
npm run test:host
npm run test:reading
node scripts/test-playback-browser.mjs
npx tsc --noEmit
npm run lint
npm run build
```

微信测试使用临时归档、模拟读取/生成器；视频播放测试使用隔离主机和媒体。真实浏览器验收仅阅读现有数据，没有新增读取或模型费用。检查报告与截图在 `outputs/observe-*`。
