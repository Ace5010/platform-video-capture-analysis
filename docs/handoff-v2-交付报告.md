# 低清在线播放、旧媒体清理、72小时新增区与粉丝量：交付报告

执行对象：`source_analysis_handoff_v2.txt`（2026-10-01 方案）。
本文件记录本次实际执行的修改、实测数据与未完成项，不是计划。

## 一、结论摘要

- 旧持久视频已全部删除：**484 个文件、19,303,437,418 字节（17.98 GiB）**，删除失败 **0** 项；数据库中的 `video_media` 登记表已退役。业务数据（16 个账号、466 条作品、886 条快照、32 次分析记录、65 条任务）全部保留。
- 采集后的自动整片下载、缺文件补齐、历史媒体回填、启动恢复下载这四条路径已全部移除，代码中不再存在任何把视频写入 `data/` 的逻辑，也没有为播放建立磁盘缓存。
- 浏览播放改为按需低清在线传输：解析目标视频绑定的低清源 → 主机内存有界预热 → 网页原生播放器经受保护的 `/api/previews/{videoId}/{generation}/media` 按 Range 取流。
- 左侧新增固定入口“新增检查视频”，按服务端发现时间滚动保留 72 小时；账号名旁显示粉丝量，与作品数分开标注。
- 自动化测试与真实浏览器验收均已实际运行，结果见第六节。

## 二、清理范围（第一步）

| 项目 | 结果 |
| --- | --- |
| 实际数据目录 | `D:\coding项目\信源抓取与分析\data\host-service`（`DOUYIN_HOST_DATA_DIR` / `DOUYIN_DATA_DIR` 均未设置） |
| 清理清单 | `media-cleanup-report.json`（数据目录、根目录、文件数、总字节、逐文件相对路径） |
| 删除文件数 | 484（全部为 `media/` 下的 `*.mp4`；其中 466 个有 `video_media` 登记，30 个是已删除作品的孤立媒体） |
| 删除字节 | 19,303,437,418 |
| 删除失败 | 0 |
| 可用空间变化 | 删除前 206,212,882,432 → 删除后 225,517,481,984，净增 **19,304,599,552 字节（17.98 GiB）** |
| 拒绝项 | 0（未发现符号链接、junction 或其他重解析点，未跟随到根目录外） |
| 备份 | `data/host-service/migration-backups/pre-media-cleanup-20261001T145115.sqlite3`（SQLite 一致性备份，非复制主库文件） |

顺序与安全检查：

1. 先停掉旧下载代码：旧主机服务进程（PID 27952）与它启动的专用浏览器子进程收到 CTRL+C 后正常退出，确认没有任何进程继续写 `media/`。
2. 再备份数据库，然后生成清单，最后按清单逐文件删除。临时目录 `data/host-service/tmp` 当时为空，无遗留临时媒体。
3. 数据库迁移删除 `video_media` 表（`DROP TABLE IF EXISTS`），不触碰 `videos`、`accounts`、`snapshots`、`analysis_runs`、`jobs`。
4. 清理脚本 `scripts/media-cleanup-report.py` 可重复执行：`--inspect` / `--backup` / `--purge` / `--verify`，逐项报告失败而不是笼统标记成功。

清理后重启主机服务并重新浏览页面：`media/` 目录为**空**，未重新出现下载任务或视频文件（见第六节实测）。

## 三、代码与行为变化

### 清理与存储

- `host_service/database.py`：删除 `queue_missing_media` / `claim_media` / `finish_media` / `media_record` / `media_counts`；启动迁移 `DROP TABLE IF EXISTS video_media`；`collection_result` 不再创建媒体登记；作品媒体状态统一报告 `online`（“没有本地文件”是正常状态，不是错误）。
- `host_service/browser.py`：删除 `_download_pending_media` / `_download_one_media` 及采集后入队、空闲补下载调用；`_loop` 不再消费下载队列。
- `host_service/analysis.py`：`_obtain_media` 不再复用“已登记持久媒体”，每次分析都在任务临时目录获取完整视频，并在成功、失败或取消后清理。
- `host_service/server.py`：删除旧的本地文件媒体接口实现。

### 在线播放与交互

- 新增 `host_service/preview.py`：低清源解析（单一来源，同一 `videoId` 合并为一次）、有界内存预热、Range 转发、上限淘汰。
- `chrome-extension/background.js`：
  - `captureFullVideoForAnalysis` 新增 `purpose` 参数，`preview` 拿到第一个可用目标绑定源即返回；`analysis` 保持原有完整取片与元数据流程。
  - 新增低清候选选择器：以短边为准（首选约 480，360–540 档可选），分辨率相当或更高时优先更低实际传输体积，选中者必须是绑定目标作品的已验证源。
- `scripts/browser-worker.mjs`：新增 `preview` 动作，与 `collect` / `capture` 共用同一套目标校验与采集函数。
- `app/page.tsx`：卡片拆分为“封面按钮（播）”与“标题/正文按钮（选）”；悬停 140 毫秒意图判定后才显示浮层；小窗保留同一 `video` 元素、同一媒体版本与 `currentTime`，只切换形态并打开声音；离开、滚动、翻页、切换账号、页面隐藏、退出登录都会结束预览并释放媒体（`load()` 中止请求）。
- `app/globals.css`：补充卡片、粉色轨道入口、粉丝量与提示跳转的样式。
- `lib/host-proxy.ts`、`app/host/[...path]/route.ts`：白名单改为新的预览路由（`prepare` POST、`status` GET、`media` GET/HEAD + Range 透传与响应校验），并为媒体路由补上 HEAD 处理函数。

### 72小时新增区

- 新增表 `collection_discoveries(account_id, video_id, discovered_at, origin_job_id, origin_event_id, origin)`，`(account_id, video_id)` 唯一键，时间字段建索引。
- 只在确实执行的 `latest` 检查中，按写入前的作品存在性计算 `new_video_ids`，并在同一事务、保存作品之后插入发现记录；首次建档、链接分析、仅刷新快照都不进入。
- 有效区间为 `discovered_at <= server_now < discovered_at + 259200`；同一检查内的作品时间戳以微秒级倒序展开，保证顺序确定且不会出现“未来时间”。
- `/api/state` 返回有效发现集合与每账号计数；账号被移除时其发现记录一并清理。
- 前端：`WorkspaceRail` 在“全部账号”下方新增固定入口，与“全部账号”选中态互斥；“全部账号”和具体账号仍走原有账号语义，虚拟分区名不会作为 `accountId` 传给采集或分析接口。
- 检查完成反馈区分“本次新发现 N 条”与“72 小时内累计 M 条”，部分失败时给出成功/失败账号数并保留成功结果，提示里可直接跳到新分区。

### 粉丝量

- 采集侧：`extractAccountPageV3` 从该账号自己的公开结构化资料读取 `follower_count`，只有结构化字段缺失时才在账号主页资料区精确读取“粉丝”标签；不硬编码私有接口，不用点赞/关注/作品数估算。
- 存储侧：`followerCount` / `followerDisplayText` / `followerCountIsApproximate` / `followerCountCapturedAt` 作为一个字段组整体替换，避免“新近似文本 + 旧精确整数”冲突；迟到的更旧响应不会覆盖较新的观测；缺少观测时保留已有值与时间。真实 0 会被保存为 0。
- 展示侧：`lib/follower-count.ts` 提供格式化与精度说明；左侧账号列表、账号卡片同一处展示，作品数继续独立标注为“N 条视频”。粉丝量读取失败不参与账号采集成功与否的判定。

## 四、实测的低清源与网络行为

### 预览转发（`scripts/test-preview-media.py`，本地媒体源）

| 场景 | 实测结果 |
| --- | --- |
| 预热范围 | 2 MiB 测试媒体上预热 448 KiB（≤ 20% 比例上限 + 单次 512 KiB 上限），远小于整片 |
| 重复范围 | 第二次相同 Range 由主机内存命中，上游字节数不增加 |
| 正常/后缀/开放式 Range | `206` + 正确 `Content-Range`，后缀 `bytes=-256` 与 `bytes=0-` 均正确 |
| 越界与非法范围 | `bytes={长度}-`、`bytes=500-100`、多段 `bytes=1-2,4-5` 均 `416`，并带 `Content-Range: bytes */总长` |
| HEAD | `200`、无正文、`Content-Length` 正确 |
| 上游忽略 Range | 断言“预热遇到 200 立即停止”，实测只读取不超过单次上限的字节；单次播放仍按请求切片返回 `206` |
| 内存上限 | 多次整片范围请求后缓存字节数始终 ≤ 上限（1 MiB 上限用例），且从不等于整片长度 |
| 权限 | 无会话 `401`、越权 `403`、未知作品 `404`、非本机来源 `403`；远程网关正常转发 Range |
| 退役路径 | `/api/media/{id}` 返回 `404`；`media/` 目录不会被创建；数据库无 `video_media` 表 |

### 低清候选选择（`scripts/test-browser-worker.mjs`，真实 Chrome 中执行采集函数）

- 1080p + 480p + 720p 候选 → 选中 480p（短边）。
- 480p/2.5 Mbps 与 360p/0.4 Mbps → 选中 360p（实际传输更小）。
- 只有 1080×1920 竖屏源 → 按短边判定为可用高清源，不误判为低清。
- 只有 1080p 与 720p → 选中 720p 作为明确回退。
- 无尺寸信息的单一候选 → 仍可使用；无目标绑定候选 → 不返回任何源。

### 首帧与停止读取（`scripts/test-playback-browser.mjs`，真实 Chrome + 本地测试媒体）

本机、本地测试媒体源下的实测（多轮中的一轮）：

- 悬停浮层出现：**≈ 550 ms**
- 媒体地址绑定：**≈ 630 ms**
- 开始播放（`currentTime > 0`）：**≈ 720 ms**（首轮含 Vite 首次编译，约 9.2 s，不代表稳态）
- 悬停期间上游传输字节 < 1.5 MiB（测试片约 2 MiB 级），确认不是整片预取
- 悬停→小窗：位置连续（`currentTime` 不倒退），未重新加载，声音打开
- 打开小窗后悬停其他卡片：不会抢走播放，媒体元素始终只有 1 个
- 关闭播放器后 1.5 秒内新增上游字节 < 2 MiB，确认停止读取而不是继续拉完整片
- 移动端触控封面可播放，无 hover 依赖

> 说明：以上是**本机 + 本地测试媒体源 + 已解析且主机已预热开头**的数字。真实抖音 CDN 的首次取址、远程手机到主机的往返与带宽都不包含在内；方案中的“p95 500 毫秒以内”只作为初始优化目标，本轮未在真实远程链路取得样本，因此不作承诺。

## 五、72小时新增区与粉丝量的实测行为

`scripts/test-collection-discoveries.py`（临时数据库 + 合成采集事件）实际覆盖：

- 首次建档（`initial`）导入 3 条历史作品 → 不进分区，作品照常保存。
- 一次 `latest` 检查发现 1 条新作品 → 只登记这 1 条，`expiresAt > discoveredAt`。
- 仅刷新互动快照（同一作品点赞数变化）→ 不新增、不重置发现时间。
- 重复投递同一事件 → 幂等忽略，不重复计数。
- 再检查发现 2 条 → 追加，顺序为新的在前，累计 3 条。
- 零新增检查 → 保留已有 3 条。
- 发布已久但本次才发现的旧作品 → 正常进入分区。
- 窗口边界：72 小时内仍在；超过 72 小时后集合为空，且作品记录数不变（退出分区 ≠ 删除作品）。
- 链接分析提交 → 不进入分区。
- 移除账号 → 其发现记录一并清理，不留下悬空计数。
- 应用内不再出现下载队列：所有作品 `mediaStatus` 为 `online`，`video_media` 表不存在。

粉丝量字段组实测：精确值保存；近似值替换时清空旧精确整数；迟到旧响应不覆盖新观测；不携带粉丝观测的采集保留原值与原时间；真实 0 保存为 0。

`scripts/test-follower-count.ts` 覆盖展示规则：未知显示“粉丝 —”；真实 0 显示“0粉丝”；8652 / 12.3万 / 1200万 / 2.3亿 的格式化；近似值显示“约1.2万粉丝”且详情说明平台只给缩写；负数、小数、非安全整数、字符串、`NaN`、`Infinity` 一律视为无有效观测；数值下降如实展示。

## 六、实际运行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:host` | 通过：主机校验、预览媒体、新增分区、远程主机、HTTPS 网关、云端流水线、用量恢复等全部子项 |
| `npm run test:browser` | 通过：浏览器驱动、历史边界、完整采集重试、**真实 Chrome 播放验收**、局域网浏览器主机 |
| `npm run test:follower-count` | 通过 |
| `npm run test:video-analytics` / `test:content-browse` / `test:analysis-usage` | 通过 |
| `npx tsc --noEmit -p tsconfig.json` | 无错误 |
| `npx eslint app/page.tsx lib/follower-count.ts lib/host-proxy.ts app/host` | 无错误、无警告 |
| `npm run lint` | 项目整体仍有既有告警；错误来自被扫描的构建产物（`outputs/cloudflare-dry-run/`、`dist/` 等），本次改动文件为 0 错误 |
| `npm run build` | 通过（含 `postbuild` 静态外壳发布） |
| `node scripts/test-live-workspace.mjs` | 通过：在运行中的工作台上确认新入口、粉丝量、卡片点击分工、悬停/离开、无新增媒体文件、无页面异常 |
| `node scripts/test-playback-browser.mjs` | 通过（见第四节实测数字） |
| `scripts/media-cleanup-report.py --inspect/--backup/--purge/--verify` | 通过（见第二节数据） |

未运行/未验证项：

- 真实抖音账号的 `latest` 检查：需要真实登录与验证码，本轮未发起（未消耗真实抓取、未调用付费模型）。
- 真实抖音 CDN 的低清源覆盖情况：只验证了候选选择逻辑与转发链路，未对真实视频逐个核对分辨率/码率/音轨格式；平台字段与 DOM 选择器以真实页面为准。
- 真实远程（Cloudflare Worker → 隧道 → 主机）播放：本机局域网与受限网关路径已测，公网隧道链路未做真机验收。
- 粉丝量真实读取：需要真实账号页；当前数据库中 16 个账号的粉丝量均为“粉丝 —”，将在下一次检查后填充。

## 七、未完成与已知限制

1. **真实远程首帧未实测**：主机预热只能减少主机再次向 CDN 取字节的等待，不能消除手机到主机的往返、带宽限制或首次取址耗时。方案中的 500 毫秒目标未在远程链路取得样本。
2. **只有高画质源的视频**：如果平台只发布高分辨率源，播放的是该实际存在的源，不会偷偷整片下载或本地转码；此限制由真实页面数据决定，本轮未做真实统计。
3. **上游不支持 Range 的源**：预热会立即停止并如实记录限制，单次播放仍按请求切片返回；不伪造拖动能力。
4. **分离音视频流**：预览只使用音画合一的 MP4；只有分离流时不会静默整片下载再合并，会按实际限制报错。
5. **浏览器的少量磁盘写入**：本轮保证了项目不建立持久媒体库、主机不写磁盘媒体缓存；操作系统页面文件与浏览器内部缓存行为不在承诺范围内。
6. **`media/` 目录仍存在但为空**：历史路径未删除目录本身，避免误删用户可能放入的其他文件；清理脚本只处理归属明确的文件。
7. **主机服务需重启生效**：Python 侧改动已重启并验证；后续若再修改 `host_service/` 或 `scripts/browser-worker.mjs`，需要再次重启。
8. **扩展（旧接口）未做真机验证**：生产模式的采集由电脑专用浏览器执行，旧扩展接口仍被拒绝；本轮未在真实扩展环境中重测。

## 八、交付物

- 清理清单与结果：`media-cleanup-report.json`、`scripts/media-cleanup-report.py`
- 新增/更新的自动测试：`scripts/test-preview-media.py`、`scripts/test-collection-discoveries.py`、`scripts/test-follower-count.ts`、`scripts/test-playback-browser.mjs`、`scripts/test-live-workspace.mjs`、`scripts/playback-fixture-host.py`
- 文档：`README.md`、`AGENTS.md`（已同步新的播放、清理、新增分区与粉丝量规则）
- 退役：`scripts/test-persistent-media.py`（对应能力已移除）

## 九、提交与工作区状态

本轮提交（基于执行前的 HEAD `4b83d43`）：

- `80c49c3` 功能：改为按需低清在线播放并清理旧持久视频
- `c109cfc` 文档：更新按需播放、媒体清理、新增分区与粉丝量说明

说明：72 小时新增分区与粉丝量的代码改动与播放改造交织在 `host_service/database.py`、`app/page.tsx` 等同一批文件中，因此随第一个提交一起入库，没有为了拆分成两个提交而重做已完成且已通过测试的代码。

工作区中保留、**未提交**的内容（属于本机原有的在途改动，本轮未触碰、未回退）：

- `android/` 目录及 `scripts/build-android.ps1`、`scripts/prepare-android-fixture.mjs`、`scripts/setup-android-signing.ps1`：另一个功能方向的在途工作。
- `.gitignore`、`cloudflare-worker.ts`、`scripts/preview-workspace-fixture.mjs`、`scripts/test-history-boundary.mjs`、`scripts/test-browser-worker.mjs`、`scripts/test-host-proxy.ts`、`scripts/test-host-service.py` 的未提交改动。
- 新增工具脚本 `scripts/stop-process-gracefully.ps1`（用于安全停止主机服务，未提交）。

当前运行状态（提交后复核）：

- 主机服务：`http://127.0.0.1:43129/health` 正常，远程通道状态 `connected`。
- 工作台：`http://localhost:3000` 返回 `200`。
- `data/host-service/media/`：**0 个文件**。

