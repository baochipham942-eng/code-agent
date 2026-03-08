# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 架构来研究 AI Agent 能力演进。

## 项目上下文

当我提到 'code agent'、'ai-code-agent' 或 'coda agent' 时，指的是本地项目（ai-code-agent）— 不是 Claude Code 或其他外部产品。

本项目主要使用 TypeScript（辅以 HTML 报告和少量 JavaScript）。新文件默认 TypeScript。

**架构分层**：工程层（core: agentLoop/tools/context/hooks/security）+ 技能层（skills: PPT/Excel/数据分析）。分析功能时必须尊重这个分层。

## 沟通规则

- 截图/参考材料默认与当前讨论相关，不要编造独立上下文
- 简短中文指令（"帮我实现"、"继续"）→ 先检查上下文中的计划/任务列表，直接执行

## 调试指南

同一问题 2 次修复失败后，停下来从头重新分析根因。

## 技术栈

- **框架**: Electron 38 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS | **状态**: Zustand
- **AI**: Kimi K2.5（主）, 智谱/DeepSeek/OpenAI（备）, Codex CLI（沙箱+交叉验证, MCP）
- **后端**: Supabase + pgvector

## 文档导航

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构索引（入口）|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/guides/tools-reference.md](docs/guides/tools-reference.md) | 工具完整参考手册 |
| [docs/guides/model-config.md](docs/guides/model-config.md) | 模型配置矩阵 |
| [docs/guides/deployment.md](docs/guides/deployment.md) | 部署配置指南 |
| [docs/guides/git-workflow.md](docs/guides/git-workflow.md) | Git 分支工作流 |
| [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md) | 问题排查 + 错题本 |
| [docs/guides/ppt-capability.md](docs/guides/ppt-capability.md) | PPT 生成系统 |
| [docs/guides/evaluation-system.md](docs/guides/evaluation-system.md) | 评测系统 |
| [docs/architecture/multiagent-system.md](docs/architecture/multiagent-system.md) | 混合多 Agent 架构 |
| [docs/decisions/](docs/decisions/) | 架构决策记录（ADR）|
| [docs/releases/](docs/releases/) | 版本发布记录 |

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 构建
npm run build:cli    # CLI 构建（独立于 build）
npm run dist:mac     # 打包 macOS
npm run typecheck    # 类型检查
```

## 开发规范

### 验证优先
- 修改代码后必须先验证，流程：`修改 → 验证 → 确认通过 → 通知`
- 写完功能点后立即 `npm run typecheck`，commit 前必须通过

### 提交纪律
- 每完成一个功能点立即提交，不要积攒

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

**新增 provider/模型/超时/价格时**，只在 `shared/constants.ts` 添加，然后引用。

**自检清单**（提交前）：
```bash
grep -rn "|| 'deepseek'" src/main/ --include="*.ts"
grep -rn "|| 'gen3'" src/main/ --include="*.ts"
grep -rn "'300000\|300_000'" src/main/ --include="*.ts"
```

## 快速参考

### 打包发布
```bash
npm run typecheck && npm version patch --no-git-tag-version
git add package.json && git commit -m "chore: bump version" && git push
npm run build && npm run rebuild-native && rm -rf release/ && npm run dist:mac
cp .env "/Applications/Code Agent.app/Contents/Resources/.env"
```

**⚠️ `rebuild-native` 不可跳过**：原生模块需用 Electron headers 重编译。

### 本地数据库
```
~/Library/Application Support/code-agent/code-agent.db
```
