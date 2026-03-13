---
description: 测试与验证规范
globs: "src/**/*.test.ts,src/**/*.spec.ts,tests/**/*"
---

# 测试规范

## 验证优先

- 修改代码后必须先验证，流程：`修改 → 验证 → 确认通过 → 通知`
- 写完功能点后立即 `npm run typecheck`，commit 前必须通过

## 调试指南

- 同一问题 2 次修复失败后，停下来从头重新分析根因

## 提交纪律

- 每完成一个功能点立即提交，不要积攒
- **后台 Agent 产物必须 review**：commit 前用 `git diff --stat` 检查每个文件的变更行数，行数异常的必须 `git diff <file>` 逐行确认，尤其是 SSE/IPC 协议文件（webServer.ts、electronMock.ts）和共享类型文件

## 代码品味

- 避免过度工程，只做必要的事
- 不添加未被请求的功能、注释或重构
- 三行重复代码优于一个过早抽象
