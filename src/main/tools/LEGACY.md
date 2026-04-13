# Legacy Tool Implementations

本目录下除以下路径外的 tool 源文件 **均为 legacy**，仅允许 `tools/modules/` 内的 wrapper 通过相对路径 import：

- `tools/modules/**` — 新 protocol 层入口，唯一允许外部 import 的 tool 实现
- `tools/registry.ts` — Protocol ToolRegistry 类（protocol 层基础设施）
- `tools/protocolRegistry.ts` — Protocol registry 单例 + 入口
- `tools/toolExecutor.ts` — 执行器（protocol dispatch 路径）
- `tools/types.ts` — 兼容类型
- `tools/fileReadTracker.ts`, `tools/dataFingerprint.ts`, `tools/permissionClassifier.ts`, `tools/backgroundTaskPersistence.ts`, `tools/executionPhase.ts` — 共享基础设施
- `tools/utils/**`, `tools/middleware/**`, `tools/decorators/**`, `tools/decorated/**`, `tools/gen5/**` — 横切基础设施

## 不得从外部（非 modules/）import 的 legacy category：

- `tools/file/`, `tools/shell/`, `tools/search/`, `tools/skill/`, `tools/lsp/`, `tools/planning/`,
- `tools/network/`, `tools/document/`, `tools/excel/`, `tools/mcp/`, `tools/multiagent/`,
- `tools/connectors/`, `tools/vision/`

这些目录下的 Tool 类是 P0-5 迁移前的实现，现在仅作为 `modules/<category>/wrappers.ts` 的委托目标存在。未来这些文件会被删除（方式：逐个 native 化 wrapper，或整体弃用换成 protocol 原生实现）。

## ESLint gate

`.eslintrc` 的 `no-restricted-imports` 规则禁止任何非 `modules/` 代码 import 上述 category 目录下的模块。违规即构建失败。

## 如何解除某个 tool 的 legacy 状态

1. 在 `tools/modules/<category>/<toolName>.ts` 写 native ToolModule 实现
2. 把 `tools/modules/<category>/wrappers.ts` 里对应的 `wrapLegacyTool(...)` 改成 import 新 native module
3. 删掉原 `tools/<category>/<toolName>.ts` 文件
4. 更新 `tools/modules/index.ts` 的 register 条目（若 import 路径变了）
