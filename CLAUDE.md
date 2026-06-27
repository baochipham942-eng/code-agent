# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 架构来研究 AI Agent 能力演进。

## LLM Wiki

项目知识库（Karpathy 模式）。操作规范见 `~/.claude/specs/wiki-schema.md`，使用 `/wiki` skill 操作。

| 目录 | 用途 |
|------|------|
| `wiki/` | LLM 维护的编译知识（概念、实体、对比、摘要） |
| `raw/` | 不可变源文档（文章、论文、竞品截图） |

Wiki 不同于 `docs/`（人类项目文档）。两者可有内容重叠但职责分离。

## 项目上下文

当我提到 'code agent'、'ai-code-agent' 或 'coda agent' 时，指的是本地项目（ai-code-agent）— 不是 Claude Code 或其他外部产品。

本项目主要使用 TypeScript（辅以 HTML 报告和少量 JavaScript）。新文件默认 TypeScript。

**架构分层**：工程层（core: agentLoop/tools/context/hooks/security）+ 技能层（skills: PPT/Excel/数据分析）。分析功能时必须尊重这个分层。

**Workbench 语义**：提到 "workbench" 指聊天主链路的能力工作台（`ConversationEnvelope` + `InlineWorkbenchBar` + Turn Timeline），与 `TaskPanel`（sidecar 深度控制面）职责分离。聊天能完成的动作不要求先打开 TaskPanel。详见 `docs/architecture/workbench.md`（ADR-011 Chat-Native Workbench，决策表见 docs/ARCHITECTURE.md）。

## 沟通规则

- 截图/参考材料默认与当前讨论相关，不要编造独立上下文
- 简短中文指令（"帮我实现"、"继续"）→ 先检查上下文中的计划/任务列表，直接执行

## 调试指南

同一问题 2 次修复失败后，停下来从头重新分析根因。

## 技术栈

- **框架**: Tauri 2.x + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS | **状态**: Zustand
- **AI**: Kimi K2.5（主）, 智谱/DeepSeek/OpenAI（备）, Codex CLI（沙箱+交叉验证, MCP）
- **后端**: Supabase + pgvector

## 文档导航

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构索引（入口）+ 决策记录（ADR）表 |
| [docs/architecture/agent-core.md](docs/architecture/agent-core.md) | Agent 核心运行时 |
| [docs/architecture/tool-system.md](docs/architecture/tool-system.md) | 工具系统 |
| [docs/architecture/multiagent-system.md](docs/architecture/multiagent-system.md) | 混合多 Agent 架构 |
| [docs/architecture/dynamic-workflow.md](docs/architecture/dynamic-workflow.md) | Dynamic Workflow 命令式脚本编排运行时 |
| [docs/architecture/data-storage.md](docs/architecture/data-storage.md) | 数据存储 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署配置 |
| [docs/api-reference/index.md](docs/api-reference/index.md) | API 参考 |
| [docs/releases/](docs/releases/) | 版本发布记录 |

> PRD / guides / 内部 spec 等产品策略类文档不进公开仓库；ADR 决策记录见 `docs/ARCHITECTURE.md` 的决策表。

## 常用命令

```bash
npm run build        # 构建
npm run build:web    # Web 构建（Tauri 前端）
npm run build:cli    # CLI 构建（独立于 build）
npm run typecheck    # 类型检查
cargo tauri dev      # 开发模式（需 HTTPS_PROXY=http://127.0.0.1:7897）
cargo tauri build    # 打包 macOS（~33MB DMG）
```

## 开发规范

### 验证优先
- 修改代码后必须先验证，流程：`修改 → 验证 → 确认通过 → 通知`
- 写完功能点后立即 `npm run typecheck`，commit 前必须通过

### 提交纪律
- 每完成一个功能点立即提交，不要积攒
- **代码质量由 Claude 负责，用户不 review 代码**：用户看不懂代码、不做 diff review，禁止把审查责任推给用户。质量靠 Claude 自审 + 分层验证保证：
  - **自审（Claude 自己做，不是甩给用户）**：commit 前 `git diff --stat` 逐文件查变更行数，行数异常的 `git diff <file>` 逐行确认；尤其 SSE/IPC 协议文件（webServer.ts、platform/）和共享类型文件
  - **分层验证（每个功能点交付前按需跑全）**：① `npm run typecheck` 必过 ② 受影响模块 targeted 测试 ③ 涉及 UI/页面走 E2E/视觉验证（/e2e）④ 高风险改动（协议/共享类型/安全/计费）用多模型对抗审查（/multi-review 或 codex-audit）
  - **向用户汇报质量证据，不贴 diff**：用自然语言说测试通过数 / 覆盖了什么 / 验证结论，让用户基于证据而非代码做判断
- **用户只在设计决策层拍板**：架构 / 产品级选择走 ADR，用人话呈现给用户拍板；拍板后 Claude 自主推进实现 + 验证，不再要求用户看代码

### 代码品味
- 避免过度工程，只做必要的事
- 不添加未被请求的功能、注释或重构
- 三行重复代码优于一个过早抽象

### 禁止硬编码（强制）

以下值 **必须** 从 `src/shared/constants.ts` 导入，禁止在业务代码中写字面量：

| 值 | 常量名 | 说明 |
|----|--------|------|
| Provider 默认值 | `DEFAULT_PROVIDER` | 禁止写 `\|\| 'deepseek'` 或 `\|\| 'moonshot'` |
| 模型默认值 | `DEFAULT_MODEL` | 禁止写 `'kimi-k2.5'` 或 `'deepseek-chat'` 作为 fallback |
| API 端点 | `MODEL_API_ENDPOINTS.*` | 禁止在 provider 中硬编码 URL |
| 超时值 | `*_TIMEOUTS.*` | 禁止写 `300000`、`30000` 等魔法数字 |
| 模型价格 | `MODEL_PRICING_PER_1M` | 禁止在多个文件中维护价格表 |
| 上下文窗口 | `CONTEXT_WINDOWS` | 禁止在多个文件中维护上下文窗口映射 |
| 视觉模型 | `ZHIPU_VISION_MODEL` | 禁止写 `'glm-4v-plus'` |
| Mermaid API | `MERMAID_INK_API` | 禁止在多个文件中定义 |
| API 版本 | `API_VERSIONS.ANTHROPIC` | 禁止写 `'2023-06-01'` |
| maxTokens 默认 | `MODEL_MAX_TOKENS.*` | 禁止散布 `8192`、`2048` |
| 目录名 | `CONFIG_DIR_NEW` (configPaths) | 禁止写 `'.code-agent'` 字面量 |
| Codex 沙箱 | `CODEX_SANDBOX.*` | 禁止写 `'codex'`、`30000` 等沙箱常量 |
| 交叉验证 | `CROSS_VERIFY.*` | 禁止写 `0.7`、`60000` 等阈值 |
| Codex 会话 | `CODEX_SESSION.*` | 禁止写 `'~/.codex/sessions'` 等路径 |
| 降级链 | `PROVIDER_FALLBACK_CHAIN` | 禁止在 modelRouter 中硬编码降级目标 |
| 时间戳更新 | 参数传入或 `?? Date.now()` | **禁止在 DB 操作中直接写 `Date.now()`**。所有写入 `updated_at` 的方法必须支持可选时间戳参数，未传时才 fallback `Date.now()`。云端同步场景必须保留远程原始时间戳 |

**新增 provider/模型/超时/价格时**，只在 `shared/constants.ts` 添加，然后引用。

**自检清单**（提交前）：
```bash
grep -rn "|| 'deepseek'" src/host/ --include="*.ts"
grep -rn "|| 'gen3'" src/host/ --include="*.ts"
grep -rn "'300000\|300_000'" src/host/ --include="*.ts"
grep -rn "Date.now()" src/host/services/core/repositories/ --include="*.ts"
```

## 快速参考

### 发版（官方）= 只推 tag，CI 接管，别本地打包

> ⚠️ **正式发版不需要本地 `cargo tauri build`**（踩坑 2026-06-09：白跑 20min 本地构建，还撞本地 syspolicyd EMFILE 把 spctl 卡住）。
> `git push origin v<version>` 触发 GitHub Actions **「Build and Release」(`.github/workflows/release.yml`)**，自动完成：**双架构 mac 矩阵（arm64 + x64，v0.16.101 起）+ 独立 build-windows job（win32-x64 NSIS，2026-06-11 起）** → mac 走 Developer ID 签名 + 公证 staple、Windows 走 unsigned NSIS + minisign → OSS 上传（versioned 路径，产物按平台+架构命名）→ publish 任务合并三平台 latest.json（darwin-aarch64 + darwin-x86_64 + windows-x86_64）→ GitHub Release → stable 提升（latest.json + release.json 含 `--exe-url` windows 资产）→ Vercel update API。签名/公证全在 CI，绕开本地签名环境问题。x64 侧改动需同步 `build-x64-test.yml`，Windows 侧改动需同步 `build-windows-test.yml`（均为手动测试构建），两者都要同步 `releaseMacosGates.test.ts` 特征断言。
>
> **Windows leg 要点**：① unsigned NSIS perUser（无 Authenticode 证书，SmartScreen 靠安装指引绕过；更新完整性走 minisign，与证书无关）；② windows leg 失败**不拖死 mac 发版**——publish `if: always() && build-mac 成功`，merge/stable 步骤对缺席的 windows 产物自动降级 mac-only；③ 改 release.yml 前先用预发布 tag（如 `v0.x.y-wintest1`，带 `-` 后缀）空跑验证——prerelease 闸门保证不提升 stable、不抢 latest；④ 真机验收清单见 `docs/architecture/windows-support.md` §5（WebView2 干净机自动装是发版前必验项）。

官方发版步骤（源码侧准备，其余 CI 做）：
```bash
npm run typecheck && npm version <version> --no-git-tag-version   # 同步 src-tauri/tauri.conf.json 的 version（注意：用字面量改，别用 $1/$2 反向引用脚本，会写坏 JSON）
# 写 docs/releases/v<version>.md（CI 的 build-stable-release-json 会把它作为 update API 的 releaseNotes）+ 更新 CHANGELOG
# 发版前只读门：npm run release:security-scan + npx vitest run tests/scripts/{verifyProductionEnv,releaseMacosGates}.test.ts
git add package.json package-lock.json src-tauri/tauri.conf.json CHANGELOG.md docs/releases/v<version>.md
git commit -m "chore: release v<version>" && git push origin main
git tag -a v<version> -m "Release v<version>" && git push origin v<version>   # ← 触发 CI 全流程
# 验证：curl "https://agentneo.vercel.app/api/update?action=check&version=0.0.0&platform=darwin&channel=stable"
```

#### 发布说明文案规则（`docs/releases/v<version>.md`，强制）

这份文件会被 CI 直接灌进 **app 内更新弹窗**（`update API releaseNotes` + OSS `latest.json` 的 `notes`），**用户会原样看到**。所以写法是「面向终端用户」，不是 changelog、不是给开发者看的：

- **禁止出现**：PR/issue 编号（`PR #260`）、commit hash、代码标识符（`DesignOutputType` / `slidesGenerator` / `SlideData[]`）、文件/路径名、API/模型内部名（`wanx2.1-imageedit` / `description_edit`）、架构黑话（"单一真源"/"非破坏性版本模型"/"零破坏"）、内部测试术语（dogfood / 对抗审计）。
- **应该写**：用户**现在能做什么**，用大白话 + 「能…了 / 可以…了」的口吻；每条一句话讲清价值，不讲实现。
- 结构：`# Agent Neo v<version>` + 日期 + 几条加粗短标题，每条一句用户视角的话。控制在屏幕一眼能扫完，别堆段落。
- 工程细节（PR、模块、价表、审计证据）写进 `CHANGELOG.md`（面向开发者），**两者分开**：CHANGELOG 可技术，release 说明必须用户向。
- 反例（不要这样）："设计 tab 按交付媒介分 4 类（`DesignOutputType` UI 聚合零破坏）…引擎抽成 slidesGenerator（SlideData[] 单一真源）"；正例："设计入口更清晰：按你想做什么分成 网页/图/演示稿/视频，进来直接选。"

### 本地 dogfood 打包（仅自测，非发版）
```bash
bash scripts/build-audio-capture.sh   # 编译 Swift 音频采集工具（首次 clone 必跑）
bash scripts/fetch-rtk.sh             # 拉取 rtk sidecar binary（首次 clone 必跑，需要 HTTPS_PROXY）
bash scripts/fetch-uv.sh              # 拉取 uv sidecar binary（首次 clone 必跑，需要 HTTPS_PROXY）
npm run typecheck && npm version patch --no-git-tag-version
# 同步 src-tauri/tauri.conf.json 中的 version
git add package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to x.x.x" && git push
npm run build && npm run build:web && HTTPS_PROXY=http://127.0.0.1:7897 cargo tauri build
bash scripts/tauri-install.sh   # 安装到 /Applications（必须用脚本，禁止手动 cp）
```

**前置条件**: Rust 工具链（`source ~/.cargo/env`）、代理（`HTTPS_PROXY=http://127.0.0.1:7897`）、Xcode Command Line Tools（swiftc）。
**首次 clone**: 必须先跑 `bash scripts/build-audio-capture.sh` 生成 `scripts/system-audio-capture`，以及 `bash scripts/fetch-rtk.sh` 拉取 `scripts/rtk`、`bash scripts/fetch-uv.sh` 拉取 `scripts/uv`，否则 `tauri.conf.json` 的 bundle resources 会找不到文件导致打包失败。
**安装**: 必须用 `scripts/tauri-install.sh`，它会 rm→cp→清理 DMG 残留卷。手动 `cp -r` 会导致旧文件残留 + Finder 反复弹出 DMG。
**⚠️ renderer 热更新缓存会盖住本地打包**: webServer 优先 serve `~/.code-agent/renderer-cache/active`（云端热更新下载的 bundle），而非 app 内置 renderer。**改 renderer 代码重新打包后，若不清缓存，看到的还是旧版**（实测踩坑 2026-06-07：改 SlashCommandPopover 重装后 E2E 仍旧行为，因 active 缓存盖住）。验证本地改动前先 `rm -rf ~/.code-agent/renderer-cache/active`，再重启 app。判定方法：`curl -s http://127.0.0.1:8180/ | grep -oE 'assets/index-[^"]*\.js'` 对比 app 内 `dist/renderer/index.html` 引用的文件名，不一致即缓存盖住。
**⚠️ renderer 端可观测性变量（`VITE_*`）必须放 `src/renderer/.env.local`**: Sentry/PostHog 的 renderer 侧读 `import.meta.env.VITE_SENTRY_DSN`/`VITE_POSTHOG_KEY`，由 Vite **构建期**注入。`vite.config.ts` 设了 `root: 'src/renderer'` 且未设 `envDir`，故 Vite 的 envDir = `src/renderer`——**变量放项目根 `.env` 不生效，必须放 `src/renderer/.env.local`**（实测踩坑 2026-06-07：值随 worktree 删除丢失后，renderer 端 Sentry/PostHog 静默 no-op，前端崩溃收不到，但 node 端正常因其运行时读 `~/.code-agent/.env`）。这三个是 public write-only 值（非 secret），但因 `.env.local` 被 gitignore，换机/重新 clone 后会丢，打包前务必确认：`grep -c '^VITE_SENTRY_DSN' src/renderer/.env.local`（应为 1），并构建后 `grep -rl 'ingest.*sentry.io' dist/renderer/assets/` 确认注入。
**API Key**: 打包后靠应用内设置管理（SecureStorage），不依赖 `.env`。`.env` 不进 app bundle（避免泄露密钥）。
**代理 / 环境变量**: webServer 启动时按序读 `~/.code-agent/.env` → 脚本同级 `.env` → 上级 `.env`。打包态走 `~/.code-agent/.env`，开发态走项目根 `.env`。Tauri 由 launchd 启动 env 是空的，海外端点（如 mimo sgp）必须在 `.env` 里写 `HTTPS_PROXY=http://127.0.0.1:7897` 才能走代理。
**Auto-update**: 首次发布前需 `tauri signer generate` 并将 pubkey 写入 tauri.conf.json。

### 本地数据库
```
~/Library/Application Support/code-agent/code-agent.db
```
