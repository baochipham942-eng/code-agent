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
- 拿不准归哪类：先写清「合入后的后果」再定；说不出后果的降 Nit。

## 不要审（CI 或 husky 已机器把关，重复报是噪音）
- 硬编码常量（provider / 模型 / 超时 / 价格）：`scripts/check-hardcoded-models.sh`。
- provider 对称性、PROMPT_VERSION bump、lint-staged 格式：husky pre-commit。
- typecheck、knip dead export、eslint 棘轮、i18n 词表上限、a11y / console / design-system 静态门：swarm-ci。
- 生成物与快照：`dist/`、`*.snap`、`tests/**/__snapshots__/**`、`docs/**/assets/**`。
- 纯文档改动（`docs/**`、`*.md`）：ship 直接标 docs-only，不进审查。

## 输出格式（机器解析，必须遵守）
先写中文 markdown 报告：Important 每条给 `文件:行号`、问题、为什么严重、怎么修；Nit 一行一条。
**最后一行必须是且只能是一行 JSON**：

```
{"important":[{"file":"src/x.ts","line":12,"summary":"…"}],"nits":[{"file":"src/y.ts","line":3,"summary":"…"}]}
```

没有问题也要输出 `{"important":[],"nits":[]}`。不要在这行 JSON 之后再写任何字。
