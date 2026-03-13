---
description: TypeScript 编码规范与常量管理
globs: "src/**/*.ts,src/**/*.tsx"
---

# TypeScript 规范

- 本项目主要使用 TypeScript（辅以 HTML 报告和少量 JavaScript）。新文件默认 TypeScript
- **架构分层**：工程层（core: agentLoop/tools/context/hooks/security）+ 技能层（skills: PPT/Excel/数据分析）。分析功能时必须尊重这个分层

## 禁止硬编码（强制）

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
| 时间戳更新 | 参数传入或 `?? Date.now()` | **禁止在 DB 操作中直接写 `Date.now()`**。所有写入 `updated_at` 的方法必须支持可选时间戳参数 |

**新增 provider/模型/超时/价格时**，只在 `shared/constants.ts` 添加，然后引用。

**自检清单**（提交前）：
```bash
grep -rn "|| 'deepseek'" src/main/ --include="*.ts"
grep -rn "|| 'gen3'" src/main/ --include="*.ts"
grep -rn "'300000\|300_000'" src/main/ --include="*.ts"
grep -rn "Date.now()" src/main/services/core/repositories/ --include="*.ts"
```
