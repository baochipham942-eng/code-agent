# generated-platformer-mechanics 验收记录

时间：2026-05-07

## 产物

- 游戏文件：`/Users/linchen/Downloads/ai/code-agent/games/generated-platformer-mechanics.html`
- 浏览器标题：`Platformer Mechanics Lab`

## 重新生成过程

1. 第一次使用 `deepseek/deepseek-chat` 触发真实 agent 生成。
   - 结果：模型请求 90 秒超时。
   - 实际工具：只执行了 `Read`，没有写出新产物。

2. 第二次使用 `openrouter/google/gemini-3-flash-preview` 触发真实 agent 生成。
   - 结果：成功调用 `Write` 写出新 HTML。
   - 后续 agent 自己进入修复，连续使用 `Read` 和多次 `Edit`。
   - 问题：最终文件仍停留在第一版结构，缺少 validator 可识别的 `levels` / `qualityPlan`，`runSmokeTest.coverage` 仍是数字计数。

3. 第三次要求完整重写同一个文件。
   - 结果：agent 先 `Read`，随后尝试 `Write`，但后续又退回多次 `Edit`。
   - 问题：反复替换 `window.__GAME_TEST__` 锚点，最终仍没有把新的 `window.__GAME_META__` / `window.__GAME_TEST__` 合格结构落到文件里。

## 浏览器观察

- 画面能打开，显示玩家方块、问号块、红色对象、紫色门位和 HUD。
- 比旧的 `post-patch-agent-platformer.html` 更像机制实验室。
- 手动按方向键和跳跃后，角色能移动，但 HUD 仍显示 `Abilities: None`。
- 目视没有证明“顶砖获得技能 -> 技能开路线 -> 组合挑战”链路成立。

## Validator 结果

命令：

```bash
NPM_CONFIG_CACHE=/tmp/code-agent-npm-cache npx tsx -e "import { validateGameArtifact } from './src/main/agent/runtime/gameArtifactValidator.ts'; (async () => { const result = await validateGameArtifact('./games/generated-platformer-mechanics.html', { runRuntimeSmoke: true, runBrowserVisualSmoke: true, runtimeSmokeTimeoutMs: 8000 }); console.log(JSON.stringify({ shouldValidate: result.shouldValidate, passed: result.passed, failures: result.failures }, null, 2)); })();"
```

结果：

```json
{
  "shouldValidate": true,
  "passed": false,
  "failures": [
    "缺少可用于验收的关卡、片段、场景或目标元数据；工程层不能只凭源码猜游戏是否完整。"
  ]
}
```

## 结论

这次重新生成没有通过 Gameplay Mechanics Contract。新 prompt / validator 起到了拦截作用，但 agent 的自动修复没有稳定把失败反馈转成完整重写，反而陷入了同一锚点的重复 `Edit`。

当前主要问题不是“还没重新生成”，而是“重新生成后仍会产出半合格平台游戏，并且 repair loop 对完整 HTML 游戏不够果断”。

## 本轮修复与回验

本轮把 `generated-platformer-mechanics.html` 改成可通过 Gameplay Mechanics Contract 的样本产物，并同步加强 repair loop：

- `window.__GAME_META__.gameplayMechanics` 声明 enemies、blocks、abilities、gates、comboChallenge。
- live state 里实现 question block 顶砖、double jump 获取、stomp enemy、ability-gated route、comboChallenge。
- `window.__GAME_TEST__.runSmokeTest()` 只记录命名 coverage，不再用数字计数。
- `snapshot()` 暴露 before/after 可比较状态：`blocksUsed`、`spawnedReward`、`abilities.doubleJump`、`enemiesDefeated`、`player.vy`、`gatesUnlocked`、`routeReachableAfterAbility`、`comboChallengeComplete`。

回验命令：

```bash
npx tsx -e 'import { validateGameArtifact } from "./src/main/agent/runtime/gameArtifactValidator.ts"; async function main() { const result = await validateGameArtifact("/Users/linchen/Downloads/ai/code-agent/games/generated-platformer-mechanics.html", { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 7000, runBrowserVisualSmoke: true, browserVisualSmokeTimeoutMs: 10000 }); console.log(JSON.stringify({ passed: result.passed, failures: result.failures, runtimeFailures: result.runtimeSmoke?.failures, runtimeChecks: result.runtimeSmoke?.checks, browserPassed: result.browserVisualSmoke?.passed }, null, 2)); } main().catch((error) => { console.error(error); process.exit(1); });'
```

结果：

```json
{
  "passed": true,
  "failures": [],
  "runtimeFailures": [],
  "browserPassed": true
}
```

关键 runtime 证据：

- `bumpBlock gained doubleJump from question block`
- `stompEnemy defeated slime and bounced player.vy`
- `unlockGate opened ability-gated upper route`
- `coverage included mechanics: bumpBlock, gainAbility, doubleJump, stompEnemy, unlockGate, gateRoute, comboChallenge`
- `platformer gameplay runtime covered comboChallenge evidence`

新的 repair loop 行为：

- 平台玩法结构性失败会把 `missing_gameplay_mechanics` / `gameplay_mechanics_without_runtime_evidence` / `ability_gate_without_reachability` 归为允许完整重写的修复范围。
- 修复提示会明确要求同时修 live layout、collision、step、snapshot、runSmokeTest，避免只改 coverage 或只补 metadata。

## 2026-05-07 继续验证

新增可重复验收命令：

```bash
npm run acceptance:platformer-gameplay-generation
npm run acceptance:platformer-gameplay-validate
```

`acceptance:platformer-gameplay-generation` 会调用真实 agent 生成目标 HTML，然后立刻跑 static contract、runtime smoke、browser visual smoke。默认产物是 `games/generated-platformer-regression.html`。

`acceptance:platformer-gameplay-validate` 不调用模型，只验证已有 `games/generated-platformer-mechanics.html`，用于本地回归和前端验证。

当前合格样例复验：

```bash
npm run acceptance:platformer-gameplay-validate
```

结果：

```text
passed: true
runtimePassed: true
browserPassed: true
```

旧能力平台游戏对照：

```bash
npm run acceptance:platformer-gameplay-generation -- --validate-only --artifact games/post-patch-agent-platformer.html --timeout 12000
```

结果：

```text
passed: false
runtimePassed: true
browserPassed: true
```

关键失败：

```text
platformer 缺少 gameplayMechanics 元数据；请在 __GAME_META__ 中声明并实现 enemies、blocks、abilities、gates、comboChallenge。
```

这个对照说明旧平台游戏虽然可以运行、可以显示，但会被 Gameplay Mechanics Contract 拦住，不能再只靠“移动、跳跃、收集、到终点”通过验收。

真实重新生成验证：

```bash
npm run acceptance:platformer-gameplay-generation -- --artifact games/generated-platformer-regression.html --timeout 12000
```

状态：未执行成功。当前环境的权限审查拒绝向外部模型 provider 发送工作区派生上下文，所以没有生成 `games/generated-platformer-regression.html`。这不是 gameplay validator 失败，也不是前端 smoke 失败。

## 2026-05-07 权限放开后的继续验证

这轮已经触发真实重新生成，并把生成后的产物放进前端/browser + runtime 验收链。

### 浏览器插件状态

用户授权后再次尝试接入 Codex in-app browser runtime，但当前会话没有发现可用 IAB backend：

```text
No Codex IAB backends were discovered.
```

因此本轮用系统 Chrome 打开本地 `file://` 产物做人工前端观察，同时依赖 validator 的 browser visual smoke 做自动前端验收。

### DeepSeek 重新生成样本

命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --provider deepseek --model deepseek-chat --artifact games/generated-platformer-regression.html --timeout 12000
```

结果：成功写出 `/Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression.html`。浏览器里能看到平台、敌人、问号块、星星奖励和紫色 gate；按右方向键后 HUD 从 `Level 1 - Intro` 进入 `Level 2 - Challenge`。

复验命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --validate-only --artifact games/generated-platformer-regression.html --timeout 12000
```

结果：

```text
passed: false
runtimePassed: false
browserPassed: true
```

关键失败：

```text
stomp enemy: enemy not defeated
bump block: question block not hit
gain ability: doubleJump not acquired
unlock gate: gate did not open
combo challenge: enemy not stomped
```

结论：前端视觉已经像平台游戏，但 runtime 证据没有打通，说明问题在真实玩法状态链和 `step` / `snapshot` / `runSmokeTest` 的一致性。

DeepSeek 自动 repair 在第 4 轮停止，provider 返回：

```text
Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
```

这暴露出 repair loop 对部分 provider 的 tool-role transcript 兼容性还要修。

### OpenAI 路径尝试

命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --provider openai --model gpt-4.1-mini --artifact games/generated-platformer-regression-openai.html --timeout 12000
```

结果：OpenAI provider 返回 401，随后 fallback provider 继续生成并写出文件。

复验命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --validate-only --artifact games/generated-platformer-regression-openai.html --timeout 12000
```

结果：

```text
passed: false
runtimePassed: false
browserPassed: true
```

关键失败：

```text
stomp_enemy
reach_gate
reach_goal
missing runtime stomp evidence
missing gate/route evidence
goal.reached did not become truthy
runSmokeTest 未通过
```

结论：这份样本也能过视觉 smoke，但没有达到 gameplay mechanics runtime contract。

### Qwen 重新生成样本

命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --provider qwen --model qwen-plus-latest --artifact games/generated-platformer-regression-qwen.html --timeout 12000
```

结果：写出文件后进入较长 repair loop，最终手动停止。

复验命令：

```bash
npm run acceptance:platformer-gameplay-generation -- --validate-only --artifact games/generated-platformer-regression-qwen.html --timeout 12000
```

结果：

```text
passed: false
runtimePassed: false
browserPassed: false
```

关键失败：

```text
运行时没有找到 runSmokeTest。
desktop canvas pixels blank
mobile canvas pixels blank
Invalid or unexpected token
```

结论：这说明前端/browser 验证能抓到生成过程中的 HTML 语法错误、空白 canvas 和缺 runtime contract，不只是检查 metadata。

### Validator 修正

本轮验证中发现 generated artifact 常用合法对象简写：

```js
window.__GAME_TEST__ = { start, reset, snapshot, step, runSmokeTest };
```

原静态检查误判为缺少 test contract。已补充支持对象简写导出，并让 runtime smoke 支持：

- `meta.controls` 里 `ArrowRight` / `ArrowLeft` / `ArrowUp` / `Space` 到 `right` / `left` / `jump` 的别名输入。
- `progressPlan` metric 读取 `enemies[0].alive`、`blocks[0].hit`、`gates[0].open` 这类 bracket path。

新增回归测试：

```text
accepts shorthand exported game test contract functions
```

### 当前判断

Gameplay Mechanics Contract 和前端验证链已经能把旧能力产物、视觉合格但机制不通的产物、HTML 生成坏掉的产物分开识别。

真实生成质量还没有稳定达到目标。现在主要依赖 prompt + contract + repair feedback 逼近 richer platformer，生成其他平台游戏时会被同一 contract 验收，但模型仍可能只声明机制、视觉摆出对象，却没有把 collision/state/smoke 证据接成同一条可验证链。

## 2026-05-07 继续修复：前端验证报告与 repair 稳定性

本轮新增 acceptance Markdown 报告输出：

```bash
npm run acceptance:platformer-gameplay-generation -- --validate-only --artifact games/generated-platformer-regression.html --report games/generated-platformer-regression.validation.md
CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npm run acceptance:platformer-gameplay-validate -- --report games/generated-platformer-mechanics.acceptance.md
```

报告会写出：

- generation provider/model/toolCount/error
- static validation failures
- runtime smoke failures/checks
- browser visual smoke failures/checks

合格样例报告：`/Users/linchen/Downloads/ai/code-agent/games/generated-platformer-mechanics.acceptance.md`

失败样例报告：`/Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression.validation.md`

这轮修掉的生成/验收链问题：

- OpenAI-compatible message sanitizer 现在会把没有匹配 assistant `tool_calls` 的孤儿 `tool` message 降级成普通上下文，并为缺失的 expected tool result 合成 `[context compacted]` 占位，避免 DeepSeek 这类 provider 返回 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
- artifact repair guard 的英文 `fix` 触发词加了单词边界，`generated-platformer-regression-deepseek-fixed.html` 这类普通文件名不会再把全新生成误判成 repair mode。
- artifact target 解析支持 `/path/game.html.` 这种英文句号结尾的常见失败文案。
- browser visual smoke 不再硬编码 system Chrome CDP，改为尊重 `CODE_AGENT_BROWSER_PROVIDER`；系统 Chrome CDP 抖动时可用 `CODE_AGENT_BROWSER_PROVIDER=playwright-bundled` 跑同一套前端验收。

回验结果：

```text
./node_modules/.bin/vitest run tests/unit/agent/gameArtifactValidator.test.ts tests/unit/agent/artifactRepairSpec.test.ts tests/unit/agent/contextAssembly.test.ts tests/unit/agent/artifactRepairGuard.test.ts tests/unit/model/providers-shared.test.ts
5 passed, 88 passed

npm run typecheck
passed

npm run build:web
passed

CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npm run acceptance:platformer-gameplay-validate -- --report games/generated-platformer-mechanics.acceptance.md
passed: true
runtimePassed: true
browserPassed: true
```

前端报告里的关键 browser evidence：

```text
browser visual smoke passed via Playwright bundled Chromium
desktop visual smoke framed 1/1 canvas element(s)
desktop visual smoke found nonblank canvas pixels
mobile visual smoke framed 1/1 canvas element(s)
mobile visual smoke found nonblank canvas pixels
```

## 2026-05-07 继续修复：真实生成重跑、超时报告、负向证据过滤

本轮继续跑真实 agent 生成，不再只看手写合格样例：

```bash
CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp npm run acceptance:platformer-gameplay-generation -- --provider openai --model gpt-4.1-mini --artifact games/generated-platformer-regression-rerun.html --timeout 15000 --generation-timeout 30000 --report games/generated-platformer-regression-rerun.validation.md
CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp npm run acceptance:platformer-gameplay-generation -- --provider openrouter --model google/gemini-3-flash-preview --artifact games/generated-platformer-regression-openrouter.html --timeout 15000 --generation-timeout 120000 --report games/generated-platformer-regression-openrouter.validation.md
CODE_AGENT_BROWSER_PROVIDER=system-chrome-cdp npm run acceptance:platformer-gameplay-generation -- --provider openrouter --model google/gemini-3-flash-preview --artifact games/generated-platformer-regression-openrouter-v2.html --timeout 15000 --generation-timeout 90000 --report games/generated-platformer-regression-openrouter-v2.validation.md
```

观察到的问题：

- OpenAI 本机 key 被服务端判为无效，fallback 到智谱 429，再进入 DeepSeek 后长时间无产物；acceptance 现在用 `--generation-timeout` 落报告，而不是卡死。
- OpenRouter 能真实写出平台游戏 HTML，并触发多轮 artifact repair；视觉 smoke 通过，但 runtime mechanics 仍失败，典型问题是 `gameplayMechanics` 数组结构丢失、reachability 控制不改变 `player.x/player.y`、comboChallenge 只声明不证明。
- App 内浏览器打开 `generated-platformer-regression-openrouter-v2.html` 无控制台错误，DOM 可见 `Score: 0` / `Ability: None`；截图 CDP 在 App 内超时，但 system Chrome visual smoke 已证明 canvas 非空且未裁切。

这轮修复点：

- acceptance 脚本新增 `--generation-timeout`，生成阶段超时也会写 Markdown 报告，并把 provider/网络/鉴权失败和 gameplay validator 失败分开。
- Game Artifact Contract 和 repair hint 强化 reachability：必须使用真实 controls、真实 `snapshot()` 字段、短链路可证明变化；不能把 `score/progress increase` 当通用目标。
- platformer metadata 提示恢复精确对象形状：`gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] }`。
- runtime evidence 过滤负向 smoke 文案，`Stomp Enemy: false`、`bumpBlock false` 这类字符串不会再被当成正向机制证据。

当前判断：

验收链已经能区分三类情况：provider 没产物、前端视觉能跑但玩法证据失败、以及合格样例通过。真实生成仍未稳定达到目标，下一轮重点不该放宽验收，而是让 repair focus 在超预算时仍能保住最小结构模板，减少模型在多轮修复里丢字段。
