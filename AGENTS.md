# AGENTS.md — AI 工人开工前必读的约束

> 本文件给在仓内开工的 AI 工人（Claude Code / Codex / GLM 等 CLI agent）读，是机器读的硬约束。
> 面向人的叙述在 `README.md`（产品）、`CLAUDE.md`（沟通与发版）、`docs/ARCHITECTURE.md`（架构索引）；两边互相引用、不重复。
> 每条断言带仓内出处（`路径` 或 `路径:行号`）；读到与代码不符的，以代码为准并报回给派单方，不要静默照抄本文。

## 1. 这是什么产品

Agent Neo 是本地优先的人机协作（cowork）产品：用户给目标，Neo 编排 AI 执行、验证、整理，交付**能直接用的产物**——网页、设计稿、演示稿、视频、看板、文档——而不是一段文字回复（`README.md:3-5`）。它不是 IDE / AI 编程助手；用户默认是非程序员，工程黑话、命令行前提、裸报错栈不许直接怼到用户脸上。仓库代号 `code-agent` 是历史名，产品名 Agent Neo。

## 2. 技术栈与版本

版本一律抄 `package.json` 与 `package-lock.json`，不许凭记忆写版本号。

| 组件 | 版本（已锁定） | 出处 |
|---|---|---|
| Node 运行时 | >=24.0.0 | `package.json:381`（engines） |
| 包管理器 | npm 11.12.1 | `package.json:4`（packageManager） |
| TypeScript | 6.0.3；typecheck 走 typescript7（npm:typescript@7 native preview） | `package.json:362,364`，`package.json:42`（script） |
| 前端框架 | React 19.2.6 | `package.json:343`，`package-lock.json:15630` |
| 状态管理 | Zustand 5.0.13 | `package.json:375`，`package-lock.json:18940` |
| 样式 | Tailwind CSS 4.3.0 | `package.json:359`，`package-lock.json:17280` |
| 桌面壳 | Tauri 2（Rust） | `src-tauri/Cargo.toml:12` |
| 构建 | esbuild 0.28.0（main/web/cli）+ Vite 8.0.13（renderer） | `package.json:306,368`，`esbuild.config.ts`、`vite.config.ts` |
| 测试 | Vitest 4.1.7 + Playwright 1.60.0 | `package.json:369,226` |
| 本地库 | SQLite（better-sqlite3 13.0.3），数据目录 `~/.code-agent/` | `package.json:221` |
| 云端 | Supabase + pgvector（迁移在 `supabase/`） | [HLD 数据架构](docs/ARCHITECTURE.md#9-数据架构) |
| 原生模块 | node-pty 1.1.0 / sharp 0.35.3 / keytar 7.9.0 / onnxruntime-node 1.24.3 / avr-vad 1.0.10 | `package.json:224,228,223,225,220` |

新 provider / 模型 / 超时 / 价格只加在 `src/shared/constants/`，然后引用，见 §5 第 1 条。

## 3. 目录结构与职责

一级目录逐个说（完整导览见 `docs/architecture/repo-map.md`，`src/host` 领域归属见 `src/host/README.md`）：

| 目录 | 职责 |
|---|---|
| `src/` | TS 主体，分七层（[HLD 目录结构](docs/ARCHITECTURE.md#目录结构)） |
| `src/host/` | 后端主进程：Agent 运行时、工具、服务、权限、任务（工程层 core + 技能层 skills） |
| `src/renderer/` | React 前端（呈现与交互，业务真源在 host） |
| `src/shared/` | 前后端共享的类型（`contract/`）、常量（`constants/`）、IPC 协议（`ipc/`） |
| `src/web/` | 本地 HTTP/SSE server |
| `src/cli/` | CLI 入口与适配层 |
| `src/design/`、`src/artifacts/` | 设计工作区共享逻辑 / 产物类型与处理 |
| `src-tauri/` | Tauri Rust 桌面外壳 |
| `admin-console/` | 独立管理后台（Next.js，`admin-console/README.md`） |
| `packages/` | 复用包：bridge（本地桥接 :9527，[HLD 集成](docs/ARCHITECTURE.md#10-集成)）、eval-harness、internal（评测中心） |
| `vercel-api/` | 官网、下载与控制面 API |
| `supabase/` | 数据库迁移与云函数 |
| `tests/` | unit / renderer / integration / e2e / smoke（约定见 `tests/README.md`） |
| `scripts/` | 构建、发布、治理、验收、运维脚本（见 `scripts/README.md`） |
| `config/` | 可入库的发布制品锁；不存 secret、不存用户配置 |
| `docs/` | 架构、部署、API、审计、发布记录 |
| `extension/` | 浏览器扩展（`extension/manifest.json`） |

三端入口：

| 端 | 入口 | 说明 |
|---|---|---|
| 桌面 | `src-tauri/src/main.rs` | Rust 壳启动内嵌 webServer，加载 `http://localhost:8180`（`src-tauri/tauri.conf.json:8`） |
| Web / 服务 | `src/web/webServer.ts` | HTTP/SSE server；构建产物 `dist/web/webServer.cjs` 是 `package.json:7` 的 main |
| Renderer | `src/renderer/index.tsx` | Vite root 固定 `src/renderer`（`vite.config.ts:75`） |
| CLI | `src/cli/index.ts` | bin `code-agent` / `neo` → `dist/cli/index.cjs`（`package.json:8-11`） |

## 4. 前后端规范

- **边界**：业务逻辑只在 `src/host/`；`src/renderer/` 做呈现与交互；跨端共享的类型、常量、协议一律放 `src/shared/`（[HLD 目录结构](docs/ARCHITECTURE.md#目录结构)）。改 `src/shared/**`、`src/web/webServer.ts`、`src/host/platform/**` 这类协议文件时两端必须对称（`REVIEW.md:12`）。
- **IPC 消费**：通道与签名真源是 `src/shared/ipc/handlers.ts`（`IpcInvokeHandlers`）与 `src/shared/ipc/channels.ts`；领域通道「一个领域一个通道、action 参数分发」（`src/shared/ipc/domains.ts:10,13`）。renderer 统一走 `src/renderer/services/ipcService.ts`（window bridge 的类型安全封装）或 `src/renderer/services/typedInvoke.ts`（dev 态带 schema 校验），不各自手拼 fetch。Skill 域的范例是 `src/renderer/services/invokeSkillIPC.ts`：只读路径 `invokeSkillIPC`（失败吞为 undefined）、动作路径 `invokeSkillIPCOrThrow`（必须把真因抛给 UI）。
- **store**：Zustand，一域一 store，全在 `src/renderer/stores/`（清单 `docs/architecture/frontend.md:380` 起；范例 `src/renderer/stores/appStore.ts`）。跨组件状态进 store，不散落组件；store 里引用常量走 `@shared/constants`（`src/renderer/stores/appStore.ts:21-26` 的 import 是范例）。
- **i18n（文案不许硬编码）**：renderer 用户可见文案一律进 `src/renderer/i18n/`（按域拆 zh/en 文件，`src/renderer/i18n/index.ts` 聚合），组件里不写裸中文串。文案 lint 门是 `scripts/check-copy.mjs`：营销压力词（轻松/一键/只需/立即体验）与错误省略号基线为 0，工程黑话只警告。host 错误不许新增裸中文文案——用稳定 code，由 renderer i18n 翻译（`scripts/host-chinese-error-ratchet.mjs`）。
- **用户面术语**：叫「插件」，不叫「能力包」（范例 `src/renderer/i18n/capabilityHub.ts:9` `tabPlugins: '插件'`）。host 存量错误串里还有旧词（`src/host/plugins/pluginRegistry.ts:189` 起），那是待清存量不是先例，新文案不许沿用。
- **密钥**：API key 不进源文件与 diff；桌面端存系统钥匙串（keytar，`package.json:223`）。密钥与脱敏细则见 `.claude/rules/security.md`。

## 5. 禁改边界

每条先写为什么。触碰前先读对应出处。

1. **常量唯一源**：provider/模型默认值、API 端点、超时、价格、上下文窗口、目录名、降级链等禁止在业务代码写字面量——多处维护必漂移（价格表错一次就是计费事故）。全量对照表见 `.claude/rules/typescript.md`「禁止硬编码」，机器门 `scripts/check-hardcoded-models.sh`。
2. **DB 时间戳**：写 `updated_at` 的方法必须支持可选时间戳参数，禁止直接 `Date.now()`——云端同步必须保留远端原始时间戳（`.claude/rules/typescript.md`，`REVIEW.md:19` 是审查项）。
3. **shell 安全档**：`getShellSafetyMode()` 全平台默认 `strict`（`src/host/security/commandSafety.ts:52`），lenient 只剩环境变量显式开启——不许加回平台分支默认；该默认被 `tests/security/commandSafety.test.ts` 钉死。
4. **棘轮与基线只降不升**：knip / eslint / host-chinese-error / check-copy / tsc-tests 等基线数字（如 `scripts/knip-ratchet-baseline.json`）调大 = 让门变瞎，ai-review 判 Important（`REVIEW.md:23`）。
5. **不许削弱既有检查**：删或放宽 `expect`、加 `skip`/`only`、断言改恒真、改别的单立下的验收断言 → Important（`REVIEW.md:23`）。
6. **未上线模块不加 legacy / fallback / 兼容分支**（`REVIEW.md:26`）。
7. **审批/沙箱/权限改动不许放宽默认**：deny 改 allow、加白名单、跳过确认、扩大可写路径 → Important（`REVIEW.md:18`）。Codex 沙箱与交叉验证默认关闭，仅环境变量显式启用（`.claude/rules/security.md`）。
8. **不落敏感信息**：凭据、token、真名、绝对家目录路径不进 diff、测试夹具、快照、截图文件名、证据档（`REVIEW.md:17`）；公开文档里用户路径以 `~` 代替。
9. **新模块只导出真有人 import 的形式**：不顺手 `export default`、不塞进 barrel 再导出——无消费方就是 dead export，knip 棘轮必报（`REVIEW.md:25`）。
10. **熔断不碰**：`~/.ship/disabled` 是用户紧急刹车，存在时自动化全停，不许删除或绕过。

## 6. 门与提交纪律

- **本机门**：交付前 `npm run gates:fast`（`scripts/gates-fast.mjs`，30–60 秒人工定义快子集，产出绑定 HEAD/tree 的 JSON 回执落 `.reports/gates-fast/`；`ship pr` 在 push 前会自己再跑一遍并核回执，回执不绑当前 HEAD、有 gate `failed`、超 180 秒都拒）。`npm run typecheck` 每次改动后必过；改动文件的单测 `npx vitest run <文件>` 必跑。全量 43 格 `npm run gates:local`（`scripts/gates-local.mjs`）保留为显式诊断入口，**不再是交付前置**——全量权威门是 PR 上的 CI（ADR-064 过渡，2026-09-06）。汇报贴快门那行「✓ gates:fast passed required local preflight … receipt=<id>」。
- **PR 门**：GitHub Actions，`.github/workflows/swarm-ci.yml`（smoke + full，merge gate），另有 provider-symmetry、repository-structure 等专项工作流（`.github/workflows/`）。改了代码的 PR 由另一家模型按 `REVIEW.md` 审（ai-review 提交状态，一条 Important 就拒合；分歧走 `--dispute` / `--arbitrate`，不许打地鼠）。纯文档改动 ship 自动标 docs-only 不进审查（`REVIEW.md:42`）。PR 描述必填测试证据与档位勾选（`.github/PULL_REQUEST_TEMPLATE.md`）。
- **ship 硬规**：推分支、开 PR、合并 main 一律走机器级命令 `ship`（`ship --help` 看全量）。串行合并队列 = 无冲突 + CI 全绿 + 不落后 main（落后自动 update-branch 重验，最多 3 轮）。一切失败 fail-closed：ship 报错就停下如实汇报，禁止手工 `git push origin main`、`gh pr merge`、`--force` 类绕过；同因连挂 2 次转人工。
- **汇报格式**：测试证词后加一行 `证据档位：<档位组合>`，四档定义在 `docs/testing-evidence-classes.md`；只有 static-contract + hermetic-protocol 时不许说「已验证」。汇报必须带全量测试计数与档位，缺一不可。
- **多 agent 并行**：认领前 `git fetch origin`，工作分支基于 `origin/main` 新建；更新本地 main 只允许 `git merge --ff-only origin/main`，拒绝 ff 说明本地 main 已脏，另起分支不要 forward-fix。push 后在交接里写明 `git rev-parse HEAD` 的 sha，接力以 sha 对齐。验收一律 `origin/main` 新鲜构建，逐层核对产物指纹；禁止拿本地残留构建、renderer 热更新缓存、旧安装包下验证结论。

## 7. 开工前检查清单

1. `git fetch origin && git merge --ff-only origin/main`——拒绝 ff = 本地 main 已脏，从 `origin/main` 另起分支。
2. 新 worktree 先 `bash scripts/worktree-bootstrap.sh <树路径>`：node_modules、sidecar 二进制都是 gitignored，缺了 vitest/tsc 会假红。
3. `node -v` >= 24（`package.json:381`）；包管理器是 npm，别用 pnpm。
4. 读 `CLAUDE.md`「开发规范」章 + `.claude/rules/` 里与本单相关的分册（testing / typescript / security / performance）。
5. 涉及共享类型或 IPC：改完核对 `src/shared/**` 两端对称，再 `npm run typecheck`。
6. 用户可见文案进 `src/renderer/i18n/`，跑 `node scripts/check-copy.mjs`；host 错误用稳定 code。
7. 跑 `.claude/rules/typescript.md` 末尾的硬编码 grep 自检清单。
8. commit 前 `git diff --check`（空白错误/冲突标记）+ `git diff --stat` 逐文件核行数，异常的逐行看。
9. 每完成一个功能点立即提交不积攒；交付前 `npm run gates:fast` 绿并贴回执行，`ship pr` 会复核。
10. 同一问题 2 次修复失败 → 停下，从头重新分析根因（`CLAUDE.md` 调试指南），不带病硬闯。
