# CodeBuddy 完整视频接入与验收

2026-10-24，本机后台已使用 CodeBuddy，默认 `minimax-m3`，明确模型额度耗尽后切换 `minimax-m3.1-flash`。用户已授权验证其他完整视频模型作为备用。

GLM-5.3-Flash 在当前 CodeBuddy 通道分别用完整 MP4 内嵌输入、完整视频公网直链实测，均回答未收到画面，因此没有启用该备用项。MiniMax-M3 和 MiniMax-M3.1-Flash 都对同一真实花朵开放视频给出了与参考画面一致的描述。

## 实现

- `host_service/codebuddy.py` 复用现有视频提示词、严格结构校验、连续无损分段和整合逻辑；不替换成关键帧、OCR 或仅口播稿。
- `scripts/codebuddy-video-worker.mjs` 为每次请求启动独立、无工具、无会话持久化的官方 CodeBuddy CLI；复用正常登录，不读取或复制凭据到 Python、数据库、日志。
- `scripts/codebuddy-video-wire.cjs` 仅在该子进程中适配原生 `video_url` 请求。保留原目的地、鉴权与计费头，核对完整源文件哈希，禁止静默重复提交。没有修改 `node_modules`。
- 40 MiB 应用内嵌上限；超过时沿用 FFmpeg stream copy 连续分段，逐段送入完整媒体后整合。输入缺失或模型未确认看到画面时不保存分析。
- 只有明确的模型额度拒绝触发备用；账户余额、登录、普通限流、网络、视频上下文与格式问题不会触发换模型。失败、取消、结构校验失败及未知提交结果均保留已知 Token 和积分；无回执部分标为待核对。
- 完整视频和有用口播稿沿用现有获取、复用与清理流程。云端口播仍用原 Qwen Key，人民币费用与 CodeBuddy 积分分开显示。
- 正常启动后台默认使用 CodeBuddy；显式设置 `DOUYIN_ANALYSIS_PROVIDER=qwen` 可使用原兼容流程。

## 真实抖音视频

- 视频：`7698692945368616207`，使用 WorkBuddy 做聊天动画特效的教程。
- 任务：`180b8660-1f2c-4003-b2d6-7443f2733c26`。
- 实测：73.94 秒，1080 × 1920，12,199,772 字节完整视频。
- 原片 SHA-256：`2a29efe135d30d048f69f1ae3ecba75ac557a91dd823620de8a4c0e843aee0a3`，与实际模型请求审计一致。
- 从入队至完成约 332.55 秒；模型子进程约 304.86 秒。
- MiniMax-M3 官方回执：输入 35,689 Token、输出 29,840 Token、总计 65,529 Token，9.29 积分。已有口播直接复用，没有新增云端转写。
- 内容分析及全部制作规范通过结构校验，SQLite 任务与分析记录均为 `succeeded`；作品显示 `ready`。后台再次重启后仍能读取和展示。
- 本次任务的临时目录已删除。其他探测媒体也已清理；只保留回执、报告、参考截图。

探测另有已确认 1.17 积分；第一次普通附件通道探测有 Token 回执但没有官方积分回执，金额保留为待核对，不写成零费用。详细索引见 `artifacts/codebuddy-video/validation-summary.json`。

## 检查

已实际执行并通过：

```text
npm run test:host
npm run test:codebuddy
npm run test:analysis-usage
npm run lint
npx tsc --noEmit
npm run build
node scripts/validate-codebuddy-live.mjs --run-real 7698692945368616207
node scripts/check-codebuddy-ui.mjs
```

额度切换用隔离的明确额度错误验证，没有为触发切换而耗尽真实额度；主、备模型的完整视频输入分别做了真实调用。隔离测试覆盖错误分类、同一完整文件切换、分段全部输入后整合、原文与临时目录边界、取消、未收到画面、结构失败和费用保留。

外部 Chrome 实际查看了 1440 × 1000 和 390 × 844 的设置页、真实结果和积分区域，无水平溢出；设置文案删去了存储实现细节，区分视频模型与云端口播 Key。截图和检查结果保存在 `artifacts/codebuddy-video/`。

一致性备份保存在 `data/host-service/migration-backups/codebuddy-pre-restart-20261024T054456Z.sqlite3`。逐行比较备份与完成后的数据库：29 个账号、954 条视频、2,211 条快照、941 条转写任务均保留；仅目标视频行新增分析。930 条暂停转写保持暂停，密钥及远程连接加密文件哈希未变化。

本次未新建分支、提交或对外部署。
