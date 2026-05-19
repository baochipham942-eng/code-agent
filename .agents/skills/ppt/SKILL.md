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

只读查找、定位、轻量摘要先用文件读取/搜索工具；只有新建 deck、改写 PPTX、导出 PDF、图表型页面或用户明确 `/ppt` 时才转入 `frontend-slides`。Marvis 的 PC 应用宝 / 小程序流程仅作参考，不进入 Agent Neo Mac runtime。

立即调用：

```json
skill({ "command": "frontend-slides", "args": "$ARGUMENTS" })
```

如果 `frontend-slides` 不可用，再向用户说明缺少替代 skill；不要回退到 `ppt_generate`。
