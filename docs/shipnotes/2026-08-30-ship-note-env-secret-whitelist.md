# Ship Note — feat/env-secret-whitelist（Bash 子进程环境密钥白名单，A8）

> 日期：2026-08-30 · 分支：feat/env-secret-whitelist（headless orchestration PR4/5，基点 origin/main 89e6cfbae）

## What / Why

Bash 工具 spawn 子进程之前，新增一道**按变量名**的密钥过滤层（borrow-list A8，P0）：变量名匹配内置密钥后缀模式的一律不进入子进程环境。这是**事前（pre-emptive）防泄漏**，与已有的 tool_result 密钥打码（事后 after-the-fact）互补——防的是无人值守批跑（headless orchestration 的主场景）里 `env`、`/proc/<pid>/environ`、崩溃转储、子进程的子进程把 provider/CI 密钥带出去。

- 新层在既有 `createSanitizedEnv`（只清洗控制字符、全量透传 process.env）**之上**组合，不改动其语义。
- **作用域边界（重要）**：只过滤 Bash 工具 spawn 的子进程（前台 / 后台 / PTY 三条路径）。**Agent 进程自身 env 不动**——它需要 provider API key 才能调模型。代码注释与本文档均显式写明这一区分。

## 默认策略 + 配置面

- 过滤模式（大小写不敏感，对齐 Windows env 名大小写不敏感语义；POSIX 上密钥也只是"惯例大写"）：`*_KEY` / `*_TOKEN` / `*_SECRET`（A8 规格三项）+ 同泄漏类的廉价扩展 `*_PASSWORD` / `*_PASSWD` / `*_PWD` / `*_CREDENTIALS`。刻意不收无分隔符的 `AUTH`/`CREDENTIAL` 模式（`XAUTHORITY`/`SSH_AUTH_SOCK` 等必须存活），保持 scope tight。
- **内置核心白名单：空**（有据：PATH/HOME/TERM/locale/shell plumbing 等常见非密钥变量均不匹配上述后缀，无需豁免；合法需求走配置逃逸口而非加宽内置名单）。见 `src/host/utils/envSecretFilter.ts`。
- **默认 fail-closed 开启**：无 policy 文件也生效。
- **逃逸口（配置面选择：`code-agent-policy.toml`，即既有企业安全策略面）**，新增 `[env_filter]` 段：
  - `strip_secret_vars = false` — 整体关闭过滤；
  - `allowed_secret_vars = ["MY_APP_API_KEY"]` — 按名放行（大小写不敏感精确名）。
  - 三层合并（project `./code-agent-policy.toml` < user `~/.code-agent/policy.toml` < system `/etc/code-agent/policy.toml`）遵循既有规则：标量高优先级覆盖（admin 可在 system 层强制重新开启），allowed 列表取高优先级非空值。
  - 选 policy.toml 而非 `.code-agent/` 项目配置的理由：这是安全策略且 admin 可强制（system 层优先），与 network/filesystem/execution 等段同一决策面、同一合并语义；示例见 `code-agent-policy.example.toml`。
- Bash 侧每次 spawn 经 `getEnvFilterPolicy(projectDir)` 读取（policyLoader 内 mtime 指纹缓存：每次调用 ≤3 次 statSync，文件变化才重新 parse；不走 `getPolicyEnforcer` 单例——它无文件时返回 null 且按 workspace 键控会被 workingDir 打抖）。

## 实现

- `src/host/utils/envSecretFilter.ts`（新增）：`filterSecretEnvVars(env, { allowedNames })` 纯函数，返回 `{ env, strippedNames }`（不 mutate 入参；stripped 只有名字，值永不进日志）。
- `src/host/security/policyFile.ts`：`SecurityPolicy` 新增 `env_filter: EnvFilterPolicy`（默认 `{ strip_secret_vars: true, allowed_secret_vars: [] }`）+ TOML 解析。
- `src/host/security/policyLoader.ts`：`mergePolicy` 合并规则 + `getEnvFilterPolicy(projectDir)`（mtime 指纹缓存的访问器）。
- `src/host/tools/modules/shell/bash.ts`：`createEvalSafeShellEnv(extra, projectDir, logger)` 在 eval 删除（CODE_AGENT_EVAL_REAL_ROOT / AUTO_TEST_* 等）**之后**叠加密钥过滤，两者相安（都是 delete 语义）；三个 spawn 点（前台 :851 / 后台 :740 / PTY :645）全部接入；剥离了变量时 `ctx.logger.debug` 记**名字**（不记值）。
- **PTY 配套修复**：`createPtySession` 调用从 `inheritProcessEnv: <eval 模式判断>` 改为恒 `false`——ptyExecutor 会把 `process.env` 垫在传入 env 底下，否则被剥离的密钥在 PTY 路径原样漏回。传入 env 本就含全量 sanitized process.env，行为唯一差异就是被删的 key 不再复活（正是目的）。

## 跨端影响声明（INTENDED）

`src/host/tools/modules/shell/bash.ts` 由 CLI / desktop / web 三端共用，本过滤**默认在三端同时改变子进程环境**——这是 A8（P0）的预期安全变更，不是副作用。逃逸口保持低成本（一行 policy 配置）。desktop/web/CLI 既有测试零修改通过（无削弱）；`npm run build` 全量（worker+web+cli+renderer）通过，证明 web/renderer 构建无恙。

## 验证证据

### 静态门

- `npm run typecheck` 0 错；`npm run build:cli` 成功（dist/cli/index.cjs 26MB）；`npm run lint` 0 error；改动文件单独 eslint 0 error 0 warning；`npm run build`（worker+web+cli+renderer）全绿。
- `npm run gates:local`：**38/38 全绿**（含 knip-dependency-gate、knip production ratchets、tsc-tests-ratchet、eslint ratchet 等）。

### 单测（新增 19 个）

- `tests/unit/utils/envSecretFilter.test.ts`（+7）：glob 后缀匹配、大小写不敏感、扩展后缀（PASSWORD/PASSWD/PWD/CREDENTIALS）、下划线分隔符要求（`KEY`/`MONKEY`/`APIKEY` 存活）、常见 plumbing 变量全存活（空核心白名单的有据性）、allowedNames 逃逸口（大小写不敏感）、不 mutate 入参且 stripped 值不外泄。
- `tests/unit/security/envFilterPolicy.test.ts`（+7）：`[env_filter]` TOML 解析、无文件默认 fail-closed、user 层关闭/放行、project 层（trusted）生效、user 覆盖 project 合并规则、mtime 指纹缓存失效重读。
- `tests/unit/tools/modules/shell/bash.test.ts`（+5，58/58 全绿）：前台真实 spawn 下 planted `*_KEY`/`*_TOKEN` 被子进程视为 unset 而普通变量可见；后台 + PTY 捕获 env 无密钥且 PTY `inheritProcessEnv===false`；`allowed_secret_vars` 放行；`strip_secret_vars=false` 全关；与 eval 模式删除组合（AUTO_TEST_* 仍删除）。
- 全量 `npx vitest run`（基点 a43c54448，无并发负载）：**2605 文件（2601 passed / 4 skipped）、22288 测试全绿，0 失败**。对照 pristine origin/main 基线同机全量：2603 文件 / 22269 测试全绿——分支 = 基线 + 19 新测试 + 2 新测试文件，账目精确对齐。首轮分支全量曾与 E2E 真实模型跑并发，出现 2 test + 1 suite 的 browser hook 超时（sidebarSessionItem.archiveAlignment / artifactPreviewHealthParity / designPreviewRepairInApp），单跑 6/6 通过、无并发重跑全绿，判定为负载 flake，与本改动无涉。

### E2E（真模型 glm-5.3-flash，sandbox /tmp/neo-e2e-envwl，新构建 dist/cli/index.cjs）

- **Run A（默认策略）**：父进程植入 `E2E_FAKE_API_KEY=sk-plant-123 E2E_FAKE_TOKEN=tok-plant-456 E2E_NORMAL_VAR=visible-1`，模型跑 `env | sort`——Bash 工具输出中 `E2E_FAKE_API_KEY`/`E2E_FAKE_TOKEN` 名字与值**完全不存在**，`E2E_NORMAL_VAR=visible-1` 在；输出中零个匹配密钥后缀的变量。
- **Run B（逃逸口）**：`~/.code-agent/policy.toml` 写 `[env_filter] allowed_secret_vars = ["E2E_FAKE_API_KEY"]` 后重跑——`E2E_FAKE_API_KEY` 重新出现在子进程 env（其值被既有 tool_result 打码为 `***REDACTED***`，恰好实证两层互补：环境层放行、输出层仍打码），`E2E_FAKE_TOKEN` 仍被剥离。验证后该临时 policy 文件已删除。
