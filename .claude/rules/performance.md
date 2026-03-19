---
description: 性能与构建规范
globs: "src/**/*.ts,package.json,vite.config.*,esbuild.*"
---

# 性能规范

## 构建

- **框架**: Tauri 2.x + React 18 + TypeScript
- **构建工具**: esbuild (main/preload) + Vite (renderer)
- **打包产物**: macOS DMG (~33MB)
- **CLI 构建**: `npm run build:cli` 必须单独执行（`npm run build` 不含 CLI）

## 上下文管理

- maxTokens 按模型查表（MODEL_MAX_OUTPUT_TOKENS），DEFAULT=16384, EXTENDED=32768
- 上下文压缩三层递进：L1 Observation Masking (≥60%) → L2 Truncate (≥85%) → L3 AI Summary (≥80%)
- 意图分类超时 3s（从 8s 优化）减少首轮延迟
- Embedding 缓存 10 分钟 TTL 避免重复 API 调用

## 搜索性能

- 翻译跳过（中→中冗余）使搜索从 90-255s 降到 6-9s
- Web Search auto_extract 搜索+提取一体化减少轮次
- Token 节省: cheerio 正文提取 vs 硬截断（实测 -54%）
