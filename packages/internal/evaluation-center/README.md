# Internal Evaluation Center

This private package owns Neo's evaluation runner, replay explorer, trajectory attribution,
evaluation UI, and eval/trajectory scripts. It is distributed only through the internal
dogfood channel and its manifest requires administrator installation.

The default application bundle must not import this directory. User feedback submission,
telemetry preferences, telemetry health, and diagnostic/log export remain in the core app.

## 题库判定标准与评测集切分不在公开仓

公开仓的 `.claude/test-cases/` 只保存题面；`expect`、`expectations` 与
`eval-splits.json` 位于私档 `code-agent-private-archive/eval/`。运行时先看
`NEO_EVAL_ANSWERS_DIR`，未设置时按 ADR-038 约定查找仓库兄弟目录；值为 `none`
可显式禁用答案侧。答案文件存在但缺少题目 id 时，该题保留在计划中并报告为
`not_run`，不会静默剔除。

新增答案时，在私档 `eval/answers/` 下按公开 YAML 的仓库相对路径找到对应文件，
在 `cases` 中按题目 id 增加 `expect` 或 `expectations`；切分只编辑私档根部的
`eval-splits.json`。本地提交前运行
`node scripts/ci/check-casebank-answers.mjs --require-private` 检查双侧完整性。

## 审批判决差分

差分层只消费 `eval:approval` 的 JSON 报告，不另造审批评测器。两侧必须显式传入同一个、
与 checkout 无关的题表绝对路径；报告保留 `{{work}}` / `{{home}}` 占位符，避免临时工作区
绝对路径制造假漂移。

旧 checkout 里的 `eval:approval` 可能还没有当前报告 schema，不能让两侧各用自己的 runner。
固定从一个包含本工具的 harness checkout 取同一份 runner，再用 `--tsconfig` 分别绑定两侧源码；
这样报告生产器一致，真实 `ToolExecutor` / 审批模块来自各自 checkout。

```bash
HARNESS_CHECKOUT=/absolute/checkout-containing-this-harness
BASELINE_CHECKOUT=/absolute/baseline-checkout
CANDIDATE_CHECKOUT=/absolute/candidate-checkout
APPROVAL_TABLES_DIR=/absolute/shared/approval-eval
APPROVAL_RUNNER="$HARNESS_CHECKOUT/packages/internal/evaluation-center/scripts/approval-eval.ts"

cd "$BASELINE_CHECKOUT"
npx tsx --tsconfig "$BASELINE_CHECKOUT/tsconfig.json" "$APPROVAL_RUNNER" \
  --tables "$APPROVAL_TABLES_DIR" --out /tmp/approval-baseline.json

cd "$CANDIDATE_CHECKOUT"
npx tsx --tsconfig "$CANDIDATE_CHECKOUT/tsconfig.json" "$APPROVAL_RUNNER" \
  --tables "$APPROVAL_TABLES_DIR" --out /tmp/approval-candidate.json

cd "$HARNESS_CHECKOUT"
npm run eval:approval:diff -- \
  --baseline /tmp/approval-baseline.json \
  --candidate /tmp/approval-candidate.json \
  --out /tmp/approval-diff.json
```

`deny → ask`、`ask → allow`、`unsafe → safe`（`isKnownSafeCommand`）会让 diff 以非零码退出。
反方向和 `riskLevel` / 理由变化会完整列出，但不阻塞。

## Known limitation

The checked-in `index.cjs` is the sandboxed lifecycle entry used by the manual package
installer. Host and renderer assets are built by the internal distribution pipeline; they
are intentionally absent from the default release artifacts.
