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

## Known limitation

The checked-in `index.cjs` is the sandboxed lifecycle entry used by the manual package
installer. Host and renderer assets are built by the internal distribution pipeline; they
are intentionally absent from the default release artifacts.
