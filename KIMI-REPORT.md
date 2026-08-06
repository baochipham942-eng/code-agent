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

## 遗留（未做，需另行排期）

1. **索引缺口未补齐**：工单要求「补齐剩余约 1.8% 未入索引的 messages，并确认新消息写入时索引同步更新」——本轮**未处理**。实测缺口：生产库 29559/30115（98.2%），Dev 库 3926/4390（89.4%）。缺的部分搜索仍搜不到。需要判断是新增未同步还是某些消息类型被排除，再决定是补 backfill 还是修写入侧同步。
2. **真机验证未做**：本轮全部为 hermetic 单测证据档位。工单验收判据要求 real-runtime（UI 搜到 × DB 查得到双信源交叉）与 5000 会话量级的性能实测数字，均未进行。
3. **性能未实测**：全库 FTS 召回在 5029 会话 / 30115 messages 规模下的响应时间没有测量。

## 落地状态

未 push、未开 PR，等监工/产品负责人拍板。
