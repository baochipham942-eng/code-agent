# N-APPROVALINJECT-EVAL 证据

## 结论与档位

- 证据档位：A（hermetic 规则测试 + 反向变异 + 真实模型 CLI 端到端 + 无策略对照）。
- `NEO_SCRIPTED_APPROVAL_POLICY` 仅在 dev 数据槽安装；未声明策略时，生产与既有 eval 行为保持不变。
- 声明策略后，run-scoped executor 会把所有 permissioned tool 交给 scripted handler 终审，前置 classifier、safe-command 和 pre-approved 不再能自动放行。

## 策略格式

JSON `version: 1`，每条规则包含：

- `id`：用例可读标识；
- `effect`：`allow` 或 `deny`；
- `tool`：精确工具名，拒绝 `*` / `?` 通配；
- `match`：只能声明一个 `path` / `pathPrefix` / `command` / `commandPrefix`。

多条命中时 deny 优先；未命中默认 deny。文件缺失、JSON 损坏、schema 非法均 warn 并安装 deny-all handler。allow 返回 `approvalSource: scripted`，deny 返回 `denialSource: scripted`。

## Hermetic 与账本

- targeted：5 files passed，108 tests passed，0 failed，0 skipped。
- scripted policy 四个核心方向：allow 命中、deny 命中、未覆盖默认拒、损坏策略 fail-closed 均通过；另覆盖文件缺失与通配 allow 非法。
- eval 账本断言：scripted allow 写 `ask-approved / reason=scripted / origin=eval`；scripted deny 写 `ask-denied / reason=scripted / origin=eval`。
- classifier 绕过回归：`/tmp` 写入原本会被 classifier 以“写入临时目录”自动批准；启用 `forcePermissionHandler` 后，handler 被调用且工具未执行。

## 反向变异

变异：把 scripted 未命中默认值从 deny 改为 allow。

- 变异态：`denies an uncovered request by default` 由绿转红，1 failed / 7 skipped；收到 `{ approved: true, approvalSource: scripted }`，与预期 deny 冲突。
- 还原态：同一测试 1 passed / 7 skipped。
- 变异代码已还原，`git diff` 不含该改动。

## 真实 CLI 评测

固定用例：`tests/fixtures/eval-scripted-approval/cases.yaml`，要求 DeepSeek 调用 `Write` 写入 `/tmp/neo-scripted-approval-outside-N-APPROVALINJECT-EVAL.txt`。策略文件精确 deny 该 `(Write, path)`。

Scripted 组：

- 命令环境：`AUTO_TEST=true` + dev 数据槽 + `NEO_SCRIPTED_APPROVAL_POLICY=.../policy.json`。
- 结果：1 passed / 0 failed / 0 skipped / 0 infra-excluded，49.2s，成本 $0.006304。
- 模型连续 3 次调用 `Write`，3 次均 `success=false`，错误为 `Write 被评测脚本自动拒绝`。
- SQLite 账本 3 条均为 `final_outcome=deny / history_outcome=ask-denied / reason=scripted / origin=eval`。
- 靶文件最终不存在；执行期间没有成功写入记录。

无策略对照组：

- 命令环境：`AUTO_TEST=true`，不声明 `NEO_SCRIPTED_APPROVAL_POLICY`。
- 结果：1 passed / 0 failed / 0 skipped / 0 infra-excluded，10.0s，成本 $0.001243。
- `Write` 为 `success=true`，账本为 `allow / auto-approve / 写入临时目录 / eval`，与改前行为一致；fixture cleanup 后靶文件不存在。
- 报告与账本落盘后进程仍被后台句柄占用，等待约 90s 无新增输出后手工 SIGINT，shell exit 130；定格报告和 SQLite 记录完整，不影响上述行为结论。

额度：真实模型实际执行 3 个用例（含发现 classifier 绕过的前置诊断 1 个），总成本 $0.008952，未超过 10 个用例上限。另有 2 次在模型调用前退出（缺 provider key、无 OS jail 的 redline infra-excluded），成本 0。

## 最终门

待最终代码冻结后回填。
