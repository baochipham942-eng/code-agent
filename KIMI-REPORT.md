# 施工报告：侧栏会话列表分页（历史会话够不到）

工单：`code-agent-private-archive/docs/plans/tickets/2026-08-07-侧栏会话列表加载上限修复工单.md`
分支：`kimi/sidebar-session-paging`（基于 `origin/main@f5deaf2ac`），未 push、未开 PR。

## 提交记录（每功能点一提交）

| sha | 内容 |
|---|---|
| `75bed2e86` | shared 常量 + contract + host 链路（limit/offset/archivedOnly 透传） |
| `eb667a2db` | renderer 分页模块 `sessionListPagination.ts` + sessionStore 最小接线 |
| `790d5d439` | 侧栏分页页脚三态 UI + i18n（zh/en） |
| `5d93ac571` | 单元测试 8 个（renderer 5 + host 3） |
| `e79394b0d` | 收窄导出面，knip 棘轮回基线 |

## 改了哪些文件及原因

- `src/shared/constants/ui.ts`：新增 `SESSION_LIST_PAGE_SIZE = 50`（禁硬编码；保持 50 = 旧默认值，首屏不劣化）。
- `src/shared/contract/appService.ts`：新增 `SessionListQueryOptions`（`includeArchived` / `archivedOnly` / `limit` / `offset`），`listSessions` 签名换用该类型。
- `src/host/services/infra/sessionManager.ts`：`SessionListOptions` 加 `archivedOnly`；`listSessions` 默认 limit 改用常量；`archivedOnly` 时路由到仓储层已有的 `db.listArchivedSessions(limit, offset, ownerId)`。净 +2 effective 行。
- `src/host/app/agentAppService.ts`：`listSessions` 把四个参数原样透传给 SessionManager；不传时行为与改动前完全一致。
- `src/host/ipc/session.ipc.ts`：`list` 动作的 payload 断言换为 `SessionListQueryOptions`（一行）。
- `src/renderer/stores/sessionListPagination.ts`（新增，206 行）：全部分页逻辑——
  - `executeLoadSessions`：首屏/刷新重置到第一页；**静默刷新（云端同步广播）按已加载窗口大小重取**（`limit = max(50, 已加载条数)`），不把用户翻出来的历史会话收回第一页；陈旧快照版本号比对逻辑原样迁入。
  - `executeLoadOlderSessions`：`offset = sessions.length` 取下一页追加，按 id 去重（翻页中途新建/活跃会话会把后续行后挤，offset 窗口会重复扫到上一页末尾）；在途期间发生本地乐观变更则丢弃本页。
  - `_sessionsLocalVersion` 版本号从 sessionStore 随迁（`bumpSessionsLocalVersion` 导出供乐观变更处调用）。
- `src/renderer/stores/sessionStore.ts`：只留接线——`loadSessions`/`loadOlderSessions` 委托给分页模块；`SessionState` 加 `hasOlderSessions` / `isLoadingOlderSessions`；归档/删除等 4 处乐观变更点改调 `bumpSessionsLocalVersion()`。effective 996 → **978**。
- `src/renderer/components/features/sidebar/SidebarSessionList.tsx`：分组列表尾部新增分页页脚三态——加载中转圈、`hasOlderSessions` 给「加载更早的会话」按钮、翻到底（已加载超一页）给「已加载全部会话」收尾文案，不静默。直接读 `useSessionStore`，不动 Sidebar 主文件 props。
- `src/renderer/i18n/sidebar.ts`：zh/en 同步新增 `loadOlderSessions` / `allSessionsLoaded`（加载中文案复用存量 `loading` 键）。
- 测试：`tests/renderer/stores/sessionStore.listPaging.test.ts`（5 个）、`tests/unit/services/infra/sessionManager.listPaging.test.ts`（3 个）。

## 前端过滤语义的取舍（工单要求写明）

分页后「前端过滤会漏掉还没加载的」分两类处理：

1. **归档/活跃/全部 三个过滤器：下沉到 SQL 层，不再漏。** 这是本次的关键修正——原实现里「已归档」过滤器是拉混合列表回前端挑，混合分页下归档会话会被摊薄到整页为零、永远翻不到。现在 `archived` 走 `archivedOnly`（SQL `status='archived'` 独立分页）、`active` 走 `includeArchived=false`（SQL 排除归档）、`all` 混排分页，三条路径分页各自成立。renderer 侧保留了同语义的前端过滤作为防御性兜底（正常路径一行都不会删，因此 `sessions.length` 恒等于已取原始条数，可直接当 offset）。
2. **文本搜索 / 状态过滤 / 轨迹过滤：仍只覆盖已加载页。** 这是存量行为的延续（改动前也只在前 50 条里搜），不是本次引入的回归；现在用户可通过翻页扩大覆盖面。全量搜索由 PR #1003（FTS）解决，两单改动面不重叠，本单不动它。搜索/筛选空态分支刻意不显示分页页脚（空态语义是「已加载范围内无匹配」，分页入口放那会误导）；分组列表分支即使搜索中也会显示页脚，继续翻页可命中更多。

## 验证结果（全部真跑，rtk proxy 取原始输出）

- `npm run typecheck`（typescript7）：**通过，0 error**。
- 新增测试：**8 passed / 0 failed / 0 skipped**（2 个文件）。
- 受影响存量测试（`tests/renderer/stores/`、`tests/unit/services/infra/`、`tests/unit/tools/modules/session/`、agentAppService.lifecycle、sessionSearch.ipc、web sessions 三个路由测试，含新增 8 个）：**638 passed / 0 failed / 0 skipped**（91 个文件）。
- 侧栏组件相关测试（sidebarProjectGroup/sidebarSessionItem/sidebarSearchDialog 等 8 个文件）：**34 passed / 0 failed / 0 skipped**。
- god-file 门：`sessionManager.ts` effective 996 → **998**（余量 2）；`sessionStore.ts` effective 996 → **978**；全仓「effective > 1000 且非白名单」= **0**，通过。
- ESLint 棘轮：errors 0/0、warnings 416/416，delta 0，通过。
- Knip dead-export 棘轮：**2687 = 基线 2687**，通过（未抬基线；初版多 3 个死导出，收窄导出面后回退）。
- Knip production 棘轮：66 = 66，通过。tsc-tests 棘轮：0/0，通过。

## 验收判据对照

- **第 51 条之后的老会话纯翻页可定位**：`sessionStore.listPaging.test.ts` 核心判据测试——`s-120` 排第 120 位，首屏 50 条不含它，三次翻页（offset 断言 0→50→100）后出现；全程无任何刷新排序时间手段。✅（单测层）；真机点开收发未验（本机无生产库环境，见下）。
- **首屏不劣化**：首屏查询参数与改动前逐项相同（limit 50 / offset 0 / includeArchived=false），SQL、IPC 载荷、渲染条数均未变——不劣化的论据是参数等价。**首屏渲染耗时的真机实测数字做不到**：本机没有 5029 会话的生产库环境，如实说明，未编造。
- **过滤/分组/排序翻页后正确**：分组/排序是 `useSidebarDerivedSessions` 对 `sessions` 数组的纯派生，追加页自动进入同一派生管线；归档/未归档两条路径各有单测（archivedOnly 独立分页、active 不混入归档）。✅（单测层）
- **单测覆盖**：offset 递进 ✅、到底边界（不足一页 → `hasOlderSessions=false`，再翻不发请求）✅、翻页中途新建会话（id 去重不错乱）✅、静默刷新保持窗口 ✅、host 透传/归档路由 ✅。

## 未完成 / 不确定处

- 真机验收（5029 会话库上翻页定位 08-04 前会话并打开收发）需要在带生产库的环境做，本施工环境做不到；单测已钉住分页逻辑本身。
- 首屏渲染耗时真机对比数字缺（理由同上）。
- 滚动到底自动触发加载未做，用的是显式「加载更多」按钮（工单允许二选一；按钮更可控，避免误触发）。

## 工单外发现的问题（只记录，未动手）

- `src/host/services/voice/voiceSessionService.ts` effective 恰好 1000，贴门线，下一个改它的人没有余量。
- `normalizeSession` 现有三处副本（sessionStore / sessionCreate / sessionListPagination，均为避循环 import 的存量模式），值得单独立项收敛。
- `sessionManager.listSessions` 的 `searchQuery` 选项语义是「先按 limit/offset 取页、再在页内过滤」，分页下会漏结果；当前无调用方组合使用两者，未动。
- web 端 `sessionDomainHandler` 的 `list` 同样只吃 `includeArchived`（web UI 无分页入口），未在本单范围。
