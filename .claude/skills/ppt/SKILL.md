---
name: ppt
description: 兼容入口：将 /ppt 请求转发到 frontend-slides 工作流
license: MIT
compatibility: code-agent >= 0.16
metadata:
  category: content-generation
  keywords: ppt, presentation, slides, powerpoint
allowed-tools:
  - skill
disable-model-invocation: true
---

这是兼容入口，不要自行规划，也不要调用 `ppt_generate`。

立即调用：

```json
skill({ "command": "frontend-slides", "args": "$ARGUMENTS" })
```

如果 `frontend-slides` 不可用，再向用户说明缺少替代 skill；不要回退到 `ppt_generate`。
