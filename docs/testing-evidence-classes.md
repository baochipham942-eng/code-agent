# 测试证据分级规范（Evidence Classes）

> 借鉴自竞品 maka-agent 的 `docs/computer-use-evidence-classes.md`，按诚实度把"这项改动验证过了"这句话拆成四个可核实的档位。动作立项见 `code-agent-private-archive/docs/competitive/maka-agent-2026-07-25-双周动向借鉴清单.md` A3。

## 为什么需要这个规范

"单测绿≠真机修复"在 Neo 的错题本里至少复发过 3 次（Open Insight 渲染合流点、派单遗漏 CI-only 门等，详见 `CLAUDE.md` 调试指南）。根因不是不写测试，而是"测试通过"这句汇报本身模糊——它可能指真机点了一遍，也可能只是 mock 掉了唯一会暴露 bug 的那一层。四档分级把这种模糊拆开：**每份证据都标一个档位，档位越低越不能当作"已验证"的充分理由。**

## 四档定义（从低到高）

| 档位 | 定义 | 能证明什么 | 不能证明什么 |
|------|------|-----------|-------------|
| **static-contract**（静态契约） | 不运行任何代码，只做结构/类型层断言：typecheck、lint 规则、schema 字段存在性、棘轮门（baseline delta） | 类型/结构没有退化；没有引入新的存量债 | 逻辑是否正确、运行时行为是否符合预期 |
| **hermetic-protocol**（封闭协议契约） | 运行代码，但边界被 mock 钉死（IPC/SSE channel、外部 API），断言严格锁定协议形状（channel 名、payload 字段）而非真实副作用 | 协议契约没有被破坏；内部状态流转在给定输入下符合预期 | mock 背后的真实实现是否也这样响应；跨进程/跨层的真实副作用 |
| **fault-injection**（故障注入 / 变异验证） | 故意打断被测逻辑的接线（删掉一行赋值、断开一个回调），确认对应测试真的会变红，再还原 | 测试本身有效——它不是"永远绿"的摆设，出问题真的会被拦下 | 生产环境下这条路径是否真的会被走到 |
| **real-runtime**（真实运行时） | 在接近生产的环境里真跑一遍：本地 dogfood 包点击、真实 API 调用、部署后 smoke、真机截图 | 端到端链路在真实环境下确实工作 | 覆盖率——真机跑一次不代表所有分支都被覆盖 |

## 使用方式

1. **每个功能点交付前**，按 `.claude/rules/testing.md` 的分层验证流程跑测试，并对每一层证据标注对应档位。
2. **档位不是互斥的，是叠加的**：一个改动通常同时有 static-contract（typecheck/lint 过）+ hermetic-protocol（单测过）+ fault-injection（新增分支跑过变异验证）。只有涉及真机行为、协议改动、UI 交互的改动才需要额外做 real-runtime。
3. **只有 static-contract 和 hermetic-protocol 时不要说"已验证"**：这两档合起来仍然可能被一个双向都错的 mock 掩盖真实 bug（例如 mock 和实现同时假设了错误的字段名）。至少补一次 fault-injection 或指出为什么风险可接受。
4. **PR / 施工单汇报格式**：在测试证词后面加一行 `证据档位：<档位组合>`，例如 `证据档位：static-contract（typecheck/eslint-ratchet/knip-ratchet）+ hermetic-protocol（IPC 协议单测）+ fault-injection（断开自由文本回传，测试真红后还原）`。

## 落地位置

- `.github/PULL_REQUEST_TEMPLATE.md` 的"测试证据"栏要求填写证据档位。
- `CLAUDE.md` 提交纪律章节的"汇报必须带全量测试计数"一条，同步要求带证据档位。

## 参考案例

PR #663（AskUserQuestion 自由文本"其他"选项）是本规范落地后的第一个参照样本：
- static-contract：`npm run typecheck`（0 错误）+ `lint:eslint-ratchet`（errors/warnings 均持平基线）+ `knip-ratchet`（2697/2697 未新增）
- hermetic-protocol：`askUserQuestion.test.ts` 对 IPC channel 名 / payload 形状的严格断言（mock 掉 `ipcHost`/`AppWindow`）
- fault-injection：故意注释掉 `handleOtherTextChange` 里把自由文本写回 `answers` 的那一行，确认 `userQuestionModal.test.tsx` 的对应用例真的变红，再还原并复验绿
- 未做 real-runtime（改动局限于 renderer 状态逻辑+ host 侧字符串拼接，本地打包点击验证留给下次批量 dogfood 一并做，风险可接受）
