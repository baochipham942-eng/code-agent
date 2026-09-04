# REVIEW.md — PR 审查政策

> 给 `ship pr` 自动叫起的审查模型读，也给任何人读。写代码的 agent 不能批准自己的代码：
> 每个改了代码的 PR 都由另一家模型按本文审一遍，结果落成 `ai-review` 提交状态；
> 有一条 Important 就红，`ship merge` 拒合。本文的改动走 PR，像代码一样审。

## 三遍怎么过

### 第一遍：bug 与逻辑错误
- 只看 diff 引入或暴露的问题：空值、边界、竞态、资源未释放、异常被吞、错误分支返回错值。
- 改了函数签名或共享类型：调用方是否全部同步。自己 grep 一遍，不信 diff 自述。
- SSE/IPC 协议文件（`src/web/webServer.ts`、`src/host/platform/**`）与 `src/shared/**` 共享类型：两端是否对称。
- 新增的异步路径：取消/超时/重试有没有落点，失败时用户看到什么。

### 第二遍：安全与数据
- 用户输入到 shell、文件路径、SQL、URL 的每一条路：有没有校验与转义。
- 凭据、token、真名、绝对家目录路径是否进了 diff（含测试夹具、快照、截图文件名、证据档）。
- 审批 / 沙箱 / 权限相关改动：是否放宽了默认（deny 改 allow、加白名单、跳过确认、扩大可写路径）。
- 写库路径：`updated_at` 是否支持传入时间戳（云端同步要保留远端原始时间戳，CLAUDE.md 禁令）。

### 第三遍：合规（对照工单、证据档与仓规）
- diff 是否超出 PR 评论里 note 指向的证据档 / 工单范围：未要求的重构、顺手改别处 → Important。
- **削弱既有检查** → Important：删或放宽已有 `expect`、加 `skip`/`only`、上调阈值或基线数字（ratchet / baseline / eslint 基线）、把断言改成恒真、改别的单立下的验收断言。
- 证据档声称的验证与 diff 对不上（说跑了 X，diff 里却没有 X 会碰的文件）→ Important。
- 新增 `export default` 或 barrel 再导出而无消费方；新增依赖而同能力已在仓内 → Nit。
- 未上线模块出现 legacy / fallback / 兼容分支（CLAUDE.md 禁令）→ Important。

## Important 与 Nit
- **Important**：合入后会出错、会丢数据、会放宽安全、会让门变瞎、或超出工单范围。一条就红。
- **Nit**：命名、注释、可读性、非必要的小重复。只列不拦；每个 PR 最多 5 条，多了砍。
- **门比需要的更严 → Nit，不是 Important**：误报、多问一次确认、扫描面比最小必要宽、白名单不够精细——
  这类方向与「放宽安全」相反，合入后既不会出错也不会泄露。除非你说得出它导致的具体坏结果
  （哪个正常操作被错误拦下、用户因此做错什么），否则不成立；说不出就是 Nit。
- 拿不准归哪类：先写清「合入后的后果」再定；**说不出后果的自己降 Nit，别塞进 Important 让机器去挡**
  ——机器只查 `consequence` 字段在不在（见下方输出格式），查不出你写的后果是真是假。

## 不要审（CI 或 husky 已机器把关，重复报是噪音）
- 硬编码常量（provider / 模型 / 超时 / 价格）：`scripts/check-hardcoded-models.sh`。
- provider 对称性、PROMPT_VERSION bump、lint-staged 格式：husky pre-commit。
- typecheck、knip dead export、eslint 棘轮、i18n 词表上限、a11y / console / design-system 静态门：swarm-ci。
- 生成物与快照：`dist/`、`*.snap`、`tests/**/__snapshots__/**`、`docs/**/assets/**`。
- 纯文档改动（`docs/**`、`*.md`）：ship 直接标 docs-only，不进审查。

## 分歧怎么了结（不许打地鼠）

审查器每轮都从零重看整个 diff，不知道上一轮提过什么、作者怎么答的。安全类补丁于是会被无限往下举反例：
修一个绕过路径就冒出下一个，作者要么无休止让步，要么把整个仓的分支保护摘掉。两条都不对。
2026-09-04 起给作者三条出口（`ship review` 的选项，理由全进 `~/.ship/audit.log`）：

1. `--dispute "<理由>"` — 记一条分歧。**后续每一轮审查都会读到它**，没有新证据不得再把该条列为 Important。
   记完跑 `--again` 重审生效。
2. `--arbitrate` — 换另一家模型做二审，**只裁决未决的 Important + 作者的驳回理由，不重扫全 diff**。
   被驳回的条目消失，全被驳回就转 success。同一 PR 判红超过 5 轮时 ship 会主动提示走这条。
3. `--override "<理由>"` — 人工裁决放行，只对当前 head 生效。**这是人的权力：写代码的 agent 不许给自己
   override**，要放行就把分歧升级给人。它替代「临时摘掉分支保护」——后者是拿全仓失防换一个 PR。

审查器视角：你**不是**在跟作者比谁更坚持。同一条你已经提过、作者驳回过、而你拿不出新证据，就不要再提。

## 输出格式（机器解析，必须遵守）
先写中文 markdown 报告：Important 每条给 `文件:行号`、问题、为什么严重、怎么修；Nit 一行一条。

**Important 每条必须带 `consequence`**：一句话写清合入后的具体坏结果（什么输入 → 什么后果）。
缺这个字段的条目**既不放行也不降级**：判决照旧 failure，PR 评论会点名要求你补上后果重报，
或者按上面的归类规则把它改写进 `nits`。别拿「可能有风险」「不够健壮」这种话拦门，
也**别把后果只写在 markdown 正文里而 JSON 字段留空**——2026-09-04 实付：初版政策把这类条目直接
降级放行，一条真发现（`>'&1'` 被误判 fd 复制、绕过写目标 ownership 检查）就这样进了 main。

**最后一行必须是且只能是一行 JSON**：

```
{"important":[{"file":"src/x.ts","line":12,"summary":"…","consequence":"…"}],"nits":[{"file":"src/y.ts","line":3,"summary":"…"}]}
```

没有问题也要输出 `{"important":[],"nits":[]}`。不要在这行 JSON 之后再写任何字。
