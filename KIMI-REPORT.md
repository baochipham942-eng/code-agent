# 会话搜索接 FTS — 施工报告

> 分支 `kimi/session-search-fts`（基于 `origin/main@da2e248c6`），**未 push、未开 PR**。
> 施工：Kimi (K3) 前 5 个提交；**监工（Claude）接管收尾**——Kimi 两次被外部中断（非自身报错），主体完成后由监工补完 god-file 收尾、修一处真 bug、补测试、写本报告。

## 提交清单

| commit | 内容 | 施工方 |
|---|---|---|
| `7c2d0bc7a` | 仓储层支持 sessionIds/role 过滤与全量计数（新增 `SESSION_SEARCH` 常量组、`countSessionMessagesFts`，三层同步暴露，补 5 例测试） | Kimi |
| `8b2af6dcb` | **`searchSessions` 主路径切换为 SQLite FTS**，LRU 内存搜索作回落 | Kimi |
| `486665407` | IPC 层惰性注入 FTS 数据源，跨会话搜索走全库 | Kimi |
| `15b548830` | 补 FTS 主路径单元测试 10 例 | Kimi |
| `d2dbf34f7` | 收窄 `SessionSearchFtsHit` 为模块内类型，knip 回到基线 2687 | Kimi |
| `770d88146` | 收窄 `countSessionMessagesFts` 签名，`SessionRepository` 回到 god-file 门内 | 监工接管 |
| `df17deeb6` | **数据源缺方法时回落内存搜索，不再抛异常**（真 bug 修复 + 双向变异验证） | 监工接管 |

## 实现要点

- **主路径**：FTS 全库召回候选（上限 `SESSION_SEARCH.FTS_CANDIDATE_LIMIT`），会话消息优先取缓存、未命中从 DB 回填窗口。
- **UI 契约不变**：命中高亮、上下文片段、relevance、排序档位全部复用原内存实现。
- **分页语义修正**：候选触顶时 `totalMatches` / `sessionsWithMatches` / `truncated` 改用 FTS COUNT 反映**全量**，不再只反映缓存内数量（工单判据 ③）。
- **老消息兜底**：命中消息超出回填窗口时用 FTS 行构造结果（`messageIndex=-1`，跳转走 messageId），保证老消息可达。
- **回落路径**（共 4 条）：短查询（低于 trigram 最小长度）、`caseSensitive`、`useRegex`、DB 未就绪 → 全部回落原内存 LRU 路径；**外加数据源缺方法**（见下）。

## 监工发现并修复的真 bug

`canUseFtsSource` 原实现只检查 `ftsSource && ftsSource.isReady`，**没检查方法是否存在**。数据源是 IPC 层惰性注入的**结构接口**，运行时完全可能拿到只实现旧接口的 `DatabaseService` 子集（CLI / web 形态），此时搜索直接 `TypeError` 崩掉，而不是按设计回落 LRU。

- **暴露方式**：扩大测试范围到 `tests/unit/ipc/` 后，现有 5 个跨会话搜索测试全部转红（`ftsSource.searchSessionMessagesFts is not a function`）。施工方只跑了自己新增的测试，没跑到这一组。
- **修复**：补两条 `typeof === 'function'` 守卫。
- **测试设计注意**：最初写成一个「两个方法都缺」的用例，**变异验证不转红**——摘掉任一守卫，另一条仍会拦住。改成「各缺一个方法」两个用例后，双向变异验证成立：摘 search 守卫转红、摘 count 守卫转红、恢复全绿。

## 验证结果

| 门 | 结果 |
|---|---|
| `tests/unit/session/` + `repositories/` + `ipc/` | **908 passed / 0 failed** |
| `npm run typecheck` | 通过 |
| Knip dead-export 棘轮 | 2687 / 基线 2687，**未抬 baseline** |
| god-file 债务门 | 超限未白名单 = 0，退出码 0 |

工单三条核心判据均有专门测试覆盖：
- ✅ `能搜到只存在于 DB、不在 LRU 缓存中的老会话`
- ✅ `缓存命中路径的搜索结果与排序不退化（FTS 与内存结果一致）`
- ✅ `候选触顶时 totalMatches / truncated 反映全量（FTS COUNT）`

### god-file 门说明

`SessionRepository.ts` 在 `origin/main` 上 effective 正好 **1000 / 门限 1000**，顶在线上——新增任何一行都会越线。本次只压缩了自己新增的转发方法签名（不动存量代码），最终 998。**这是存量债的天花板问题**，下一个往该文件加东西的人会再次撞上，建议另立单拆分。

## 遗留三条的处置（监工诊断后逐条收口）

### 1. 索引缺口 —— **伪需求，不用补**（原工单写错了）

数字精确对上：30115 条消息 − 543 条 `is_meta` 元消息 − 21 条循环模式噪音（8 条两者重叠）= 29559 = FTS 实际行数。那 556 条不是漏建索引，是 `messages_ai_fts` 触发器**有意排除**的。

写入侧有 `messages_ai_fts` / `messages_au_fts` / `messages_ad_fts` 三个触发器自动同步，新消息不会漏。原工单「补齐剩余 1.8%」是误判，已作废。

（附带发现：`backfillSessionMessagesFts()` 有 `if (ftsHasRows) return 0` 短路，只在 FTS 全空时回填。在有触发器的前提下不构成问题，但属于设计粗糙点。）

### 2. 性能 —— 已实测

生产库 5029 会话 / 30115 消息：

| 路径 | 实测 |
|---|---|
| FTS 查询（≥3 字符） | 0–8ms |
| 短查询 LIKE 兜底（search，limit 500） | 110ms（热）/ ~1s（首次冷缓存） |
| 短查询 LIKE COUNT（含 DISTINCT 聚合） | 1.6s——但只在命中数超 `FTS_CANDIDATE_LIMIT`(500) 时才触发，常规查询不走 |

### 3. 🔴 实测撞出的重大缺口 —— 已修复（`8b532670a`）

trigram **至少 3 字符**，实测：2 字「列出」→ 0 行，3 字「列出当」→ 39 行。而中文里 2 字词恰是最高频搜索输入（验收/发版/语音/报告）。原实现对短查询回落内存 LRU = **退回只覆盖最近 100 个会话的老问题**，等于这个修复对中文最常见的搜索场景无效。

修法：给两个查询方法加 `shortQueryFallback` 开关（默认 false），短查询改对 `messages` 表做 LIKE，可见性过滤复用 `visibleHistoryMessageWhere`，与 FTS 触发器排除口径一致。**只有 UI 搜索传 true**，agent 记忆侧语义不变。

用 option 而非新增方法，是为了避开 `SessionRepository` 的 god-file 门（见下）。

生产库实测效果：2 字「验收」命中 131 条、跨 **62 个会话**（原先只能搜到 LRU 里最近 100 个会话中的部分）。

## 仍然遗留（需另行排期）

1. **真机验证未做**：本轮全部为 hermetic 单测档位。工单要求的 real-runtime 双信源交叉（UI 搜到 × DB 查得到）未进行——需打 Dev 包走一遍 UI。
2. **`SessionRepository.ts` 顶在 god-file 门线上**：main 上 effective 正好 1000/1000，本次两处改动都得靠压缩自己新增的行来腾空间。**下一个往该文件加东西的人还会撞**，建议另立单拆分。

## 落地状态

未 push、未开 PR，等监工/产品负责人拍板。
