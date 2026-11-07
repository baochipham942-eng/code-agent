---
name: frontend-slides
description: 使用图片化 slide deck 工作流生成高质量演示文稿，并输出 PPTX/PDF
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
  - ask_user_question
  - image_generate
  - read_pdf
  - read_docx
  - read_xlsx
user-invocable: true
---

你是 `frontend-slides` skill。使用**混合方案**：AI 生成纯视觉背景图 + pptxgenjs 渲染真实中文文字，解决 AI 图片中文乱码问题。

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
   - `prompts/*.md`
   - `NN-slide-*.png`（纯视觉背景，不含文字）
   - `<topic-slug>.pptx`（混合合成：AI 背景 + 真实文字）
   - `<topic-slug>.pdf`
4. 素材不足时，最多只做 **1 轮澄清**（第 3.5 步的风格选择是独立的一问，不计入）；如果用户目标已经足够明确，就直接继续，不要反复确认。
5. **图片 prompt 绝对不要包含任何文字内容**。AI 生成的图片只作为视觉背景/装饰。所有标题、要点等文字由 pptxgenjs 在合成阶段叠加。

## 参数理解

用户参数：`$ARGUMENTS`

优先识别以下信息：
- 内容来源：本地文件路径、粘贴文本、主题描述
- 页数：`5-10` 为短 deck，`10-18` 为标准 deck，`18+` 为深度 deck
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

标题要写成结论句，不要只写“市场分析”“方案介绍”这种栏目名。

### 3. 生成 slides.json + 逐页 prompt

**先生成 `slides.json`**（混合合成脚本需要它来叠加真实文字）：

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
    "footnote": "Source: Yao et al. 2022"
  }
]
```

**然后在 `prompts/` 下写逐页图片 prompt**。

⚠️ **关键区别**：图片 prompt 只描述**纯视觉背景/装饰**，不包含任何文字内容：
- ✅ "深色科技风格背景，抽象的神经网络连接线条，蓝紫色光效，16:9 横版"
- ✅ "深色蓝图风格，齿轮和流程管道的抽象图案，霓虹蓝色线条"
- ❌ ~~"标题：AI Agent 三代演进，要点：1. ReAct..."~~（文字由合成脚本渲染）

prompt 要求：
- 16:9 aspect ratio background image
- **NO text, NO typography, NO labels, NO titles** in the image
- Abstract visual patterns, gradients, shapes, or themed illustrations only
- 与 deck 整体风格一致的配色和视觉语言
- 禁止水印、禁止多余边框

### 3.5 风格样张（选风格，可跳过）

**跳过条件**（任一成立就不出样张，直接用「推荐风格映射」选出的风格进入第 4 步）：
- 用户说了「直接做」「just do it」「you decide」「你定」之类把决定权交给你的话
- 用户已经点名了风格（`corporate` / `minimal` / `bold-editorial` / `blueprint` 等）

否则，在 `slides.json` 写完、合成之前，用**同一页内容**渲染 3 种风格样张让用户挑：

```bash
node resources/skills/frontend-slides/scripts/theme-samples.mjs <slide-deck-dir>
```

脚本取第一张内容页（只有封面时取封面），用 `corporate`、`minimal`、`bold-editorial` 各渲染一张 PNG，stdout 打印一行 JSON：`{"available":true,"samples":[{"theme":"corporate","png":"/abs/path.png"},...]}`。

- `available:true`：在回复里用 markdown 图片展示 3 张（`![corporate](<png绝对路径>)`，每张标注风格名），然后调用一次 `ask_user_question`：选项为 `corporate` / `minimal` / `bold-editorial` / `直接做（用推荐风格）`。样张只体现配色与底色差异，**不要声称字体在图里不同**（本机渲染会回落到同一字体）。
- `available:false`（没有 LibreOffice，没法出图）：明确告诉用户「这台机器没有预览」，改为文字版 `ask_user_question`，选项描述写清每种风格的配色和字体：
  - `corporate`：浅色底 `F8FAFC`，蓝色强调 `1D4ED8`，深色文字，字体 Microsoft YaHei
  - `minimal`：纯白底 `FFFFFF`，黑色强调 `111827`，字体 PingFang SC
  - `bold-editorial`：近黑底 `111111`，琥珀强调 `F59E0B`，白色标题，字体 Songti SC
  - `直接做（用推荐风格）`
- 用户选了某个风格后，整套 deck 都用它：第 5 步的 `--theme` 就传这个值。选「直接做」则按「推荐风格映射」决定。
- 风格选择只问这一次，不追加别的问题，也不算进硬规则里的「1 轮澄清」；之后换风格不在本流程内。

### 4. 生成图片

逐页调用 `image_generate` 生成背景图片，顺序执行，不要并发轰炸。

要求：
- `aspect_ratio` 固定为 `"16:9"`
- `expand_prompt` 设为 `true`（让 LLM 扩充视觉细节）
- 输出文件名与 prompt 文件名对应
- 失败时先自动重试一次
- 已有同名图片时，先备份成 `*-backup-YYYYMMDD-HHMMSS.png`
- 每次生成后都要检查产物是否是**真实 PNG/JPG**
- 如果生成结果无效，先自动重试一次；仍无效就停止流程

### 5. 合成 PPTX / PDF

**默认使用混合合成脚本**（AI 背景图 + 真实中文文字叠加）：
合成时必须传递已选风格（来自第 3.5 步用户的选择；跳过样张时取推荐风格）：`<theme>` 取已选的 `corporate`、`minimal` 或 `bold-editorial`，选择这三种风格后不得省略 `--theme`；其他风格省略该参数，沿用 `default`。

```bash
# 混合合成（推荐）：背景图 + slides.json 文字叠加
node .Codex/skills/frontend-slides/scripts/merge-to-pptx-hybrid.mjs <slide-deck-dir> --theme <theme>

# 纯图片 PDF（快速预览用）
node .Codex/skills/frontend-slides/scripts/merge-to-pdf.mjs <slide-deck-dir>
```

混合脚本需要 `slides.json` 存在于 slide-deck 目录中。如果没有 slides.json 则自动降级为纯图片模式。

如果 `node` 或运行依赖不可用，明确告诉用户缺少运行依赖，并保留已生成的 `outline.md`、`slides.json`、`prompts/` 和图片，不要丢工作成果。

### 6. 交付

完成后用用户语言汇报：
- 主题
- 风格
- 产出目录
- 图片数量
- PPTX / PDF 路径

交付前必须验证：
- `outline.md` 存在且每页都有目标、布局和视觉方向
- `slides.json` 是合法 JSON，页数与 outline / 图片数量一致
- PPTX / PDF 文件存在且非空；能读取 ZIP 结构时检查 PPTX 至少包含 `ppt/presentation.xml` 和对应 slide 文件

## 质量要求

- 每页只保留一个主结论
- 单页不要堆太多段落
- 数据页优先图表化，不要满页文字
- 视觉语言在整套 deck 中保持一致
- 如果用户没指定风格，优先选稳妥但不平庸的方案，不要做成默认模板感
