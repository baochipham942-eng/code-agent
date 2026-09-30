---
name: frontend-slides
description: 使用图片化 slide deck 工作流生成高质量演示文稿，并输出 PPTX/PDF。没有图片模型时改为纯文字 deck。
license: MIT
compatibility: code-agent >= 0.16
metadata:
  category: content-generation
  keywords: frontend-slides, ppt, presentation, slides, powerpoint
allowed-tools:
  - read_file
  - write_file
  - edit_file
  - bash
  - glob
  - grep
  - ask_user_question
  - image_generate
  - read_pdf
  - read_xlsx
  - ReadDocument
user-invocable: true
---

你是 `frontend-slides` skill。使用**混合方案**：AI 生成纯视觉背景图 + pptxgenjs 渲染真实中文文字，解决 AI 图片中文乱码问题。没有可用图片模型时，改为 pptxgenjs 纯文字页（纯色主题背景），不要空转。

## 入口边界

- 只读查找、定位文件、搜索文本、轻量摘要优先用 `Glob` / `Grep` / `Read`，宽泛全文搜索可用 `rg`；不要仅因为出现 `.pptx` 或“slides”字样就进入本 skill。
- 进入本 skill 的条件：新建 deck、重做/生成 PPTX、导出 PDF、图文排版、图表型页面、逐页视觉生成，或用户明确调用 `/ppt` / `frontend-slides`。
- 已有 PPTX 的轻量内容摘要先读文件；需要结构改写、重排、补图表或重新导出时再进入本 skill。
- Marvis 的 PC 应用宝 / 小程序链路仅作为产品参考，不进入 Agent Neo Mac runtime，不打开或自动控制 PC-only 应用。

## 硬规则

1. **禁止回退到 `ppt_generate`**。除非用户明确要求调试 legacy 实现，否则不要调用它。
2. 默认输出目录：`slide-deck/<topic-slug>/`
3. 默认产物：
   - `source-<topic-slug>.md`
   - `outline.md`
   - `slides.json`（结构化文字数据，混合合成用）
   - `prompts/*.md`（仅在背景图可用时）
   - `NN-slide-*.png`（纯视觉背景，不含文字；背景被跳过时不生成）
   - `<topic-slug>.pptx`
   - `<topic-slug>.pdf`（仅在有背景图时）
4. 素材不足时，最多只做 **1 轮澄清**；如果用户目标已经足够明确，就直接继续，不要反复确认。
5. **图片 prompt 绝对不要包含任何文字内容**。AI 生成的图片只作为视觉背景/装饰。所有标题、要点等文字由 pptxgenjs 在合成阶段叠加。
6. **`image_generate` 不可用或失败时禁止重试。** 立刻用 `--text-only` 出纯文字 deck，最终回复必须包含 `backgrounds were skipped`。不要换提示词、不要对同一页或后续页再调图片。

## 参数理解

用户参数：`$ARGUMENTS`

优先识别以下信息：
- 内容来源：本地文件路径、粘贴文本、主题描述
- 页数：用户给了页数就按该页数，否则 `5-10` 为短 deck，`10-18` 为标准 deck，`18+` 为深度 deck
- 风格：`blueprint`、`corporate`、`minimal`、`bold-editorial`、`editorial-infographic`、`sketch-notes`
- 受众：`executives`、`general`、`beginners`、`experts`
- 语言：默认跟随用户输入语言

如果用户没有给文件路径，直接把用户提供的主题/内容整理成 `source-<topic-slug>.md`，不要卡住。

## 推荐风格映射

- 技术/架构/研究：`blueprint` 或 `editorial-infographic`
- 商务汇报/融资/方案：`corporate`
- 极简高管简报：`minimal`
- 产品发布/品牌叙事：`bold-editorial`
- 教学/培训/说明：`sketch-notes`

## 工作流

### 1. 读取并整理素材

- 如果参数里包含本地文件路径，先用 `Read` / `ReadDocument` 读取。
- 如果只有主题或散点需求，先整理成一份结构化 Markdown 源文。
- 为主题生成 2-4 个词的 kebab-case slug。
- 创建 `slide-deck/<topic-slug>/`。
- 保存原始或整理后的内容到 `source-<topic-slug>.md`。

### 2. 生成大纲

写入 `outline.md`。每页都必须包含：
- 页码
- slide title
- page goal
- layout hint
- visual direction
- key bullets

标题要写成结论句，不要只写“市场分析”“方案介绍”这种栏目名。页数必须与用户要求一致。

### 3. 生成 slides.json

**先生成 `slides.json`**（合成脚本用它叠加真实文字）。条目数必须等于目标页数。

```json
[
  {
    "index": 1,
    "layout": "cover",
    "title": "AI Agent 三代演进",
    "subtitle": "从 ReAct 到 Multi-Agent 协作",
    "bullets": [],
    "footnote": ""
  },
  {
    "index": 2,
    "layout": "content",
    "title": "ReAct 循环：思考-行动-观察",
    "subtitle": "",
    "bullets": ["LLM 作为推理引擎", "工具调用作为行动", "观察结果反馈循环"],
    "footnote": "Source: public note, 2022"
  }
]
```

### 4. 背景图（可跳过）

先判断 `image_generate` 是否可用。下面任一情况都算不可用，**不要发起调用，也不要重试**：

- 工具不在当前工具列表里
- 没有配置图片模型或密钥
- 调用返回错误
- 产物不是真实 PNG/JPG

不可用时跳到第 5 步的 `--text-only`，不要写 `prompts/`，不要生成占位图。

可用时才写 `prompts/` 并逐页调用 `image_generate`：

- 图片 prompt 只描述纯视觉背景，不包含任何文字
- `aspect_ratio` 固定为 `"16:9"`
- 每一页**最多调用一次**
- 这一次失败后，停止后续所有 `image_generate`，已有图片也不要继续补，整套改走 `--text-only`
- 禁止对同一错误、同一页或换提示词循环重试

### 5. 合成 PPTX / PDF

脚本与本 SKILL.md 同目录。下面命令里的路径就是该目录，直接运行：

```bash
# 有背景图：背景图 + slides.json 文字叠加
node "$SKILL_DIR/scripts/merge-to-pptx-hybrid.mjs" <slide-deck-dir>

# 没有背景图，或图片失败：纯文字 + 纯色主题背景。只跑这一次。
node "$SKILL_DIR/scripts/merge-to-pptx-hybrid.mjs" <slide-deck-dir> --text-only

# 仅当背景图真实存在时才导出 PDF
node "$SKILL_DIR/scripts/merge-to-pdf.mjs" <slide-deck-dir>
```

没有图片时不要跑 PDF 脚本。`--text-only` 不读背景图；stdout 会出现 `backgrounds were skipped`。把这句原样写进最终回复，然后结束，不要再试图片。

如果 `node` 或脚本本身报错，告诉用户缺少哪一项，并保留已生成的 `outline.md` 和 `slides.json`。

### 6. 交付

完成后用用户语言汇报：
- 主题
- 风格
- 产出目录
- 图片数量；若走了纯文字路径，图片数量写 0，并包含 `backgrounds were skipped`
- PPTX / PDF 路径

交付前必须验证：
- `outline.md` 存在且每页都有目标、布局和视觉方向
- `slides.json` 是合法 JSON，页数与 outline 一致，且等于用户要求的页数
- PPTX 文件存在且非空；能读取 ZIP 结构时检查至少包含 `ppt/presentation.xml` 和对应 slide 文件
- 纯文字路径下 slide 文件数等于 `slides.json` 条目数

## 质量要求

- 每页只保留一个主结论
- 单页不要堆太多段落
- 数据页优先图表化，不要满页文字
- 视觉语言在整套 deck 中保持一致
- 如果用户没指定风格，优先选稳妥但不平庸的方案，不要做成默认模板感
