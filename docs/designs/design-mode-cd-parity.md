# 设计模式：对标 Claude Design 能力补全（CD-Parity）· spec

> **状态**：✅ **四件全部实现 + 合本地 main（未推 origin）**。§1 我的品牌契约（B1 持久化/强绑/UI + B2 参考图提取）、§2 PDF 导出、§3 原型就地文本编辑、§4 PPTX 薄版均落地；对抗审计（独立子 agent 当反方）抓 7 真 bug 全修；真 key dogfood（B2 vision / PDF chromium 矢量 / 内联编辑 headless 活体 / PPTX webServer）通过。as-built 见 `docs/architecture/design-mode.md` §5.9–§5.12 + §6.6 + §9/§10。
> **来源**：对比 claude.ai/design 找出的缺口/部分项；OpenDesign reference-design-contract / question-form + Lovable/v0 inline edit 借鉴。
> **前置**：建立在已发版 v0.18.0 的设计模式（画布 + 原型 + T1–T6）+ P1 生图切换 + 标注重绘 + 视频 P2/P3 之上。
> **配套**：`docs/designs/design-mode-model-switcher.md`（D1–D9）、`docs/competitive/opendesign-lovart-借鉴清单.md`（借鉴源 + 三档分类）、`docs/designs/design-system.md`（**Neo 自身 app UI 契约，与本文 §1 不同层，勿混**）。
> **落地纪要**：原在隔离 worktree `feat/cd-parity-explore` 实现，已 `--no-ff` 合本地 main；设计模式裸 button 经 W3 收口（baseline 738，design-mode 0 未声明）；registry 加并发 mutex（审计 MED-2）。

---

## 0. 总览与优先级

| # | 件 | 定位 | 林晨拍板 | 实施量 |
|---|----|------|----------|--------|
| **1** | **我的品牌契约**（Brand Contract registry） | 最战略·anti-slop 头号杠杆 | OpenDesign 式：参考图 → Keep/Change/Do-not-copy 契约 → registry 选中绑定 → 强制注入 | 中 |
| **2** | **PDF 导出** | 快赢 | HTML 走 `page.pdf()`，图片类走 pdfkit 嵌图 | 低–中 |
| **3** | **原型就地文本编辑** | 看方向 | 就地落盘 + 模式切换 + 可手动存版本 | 中 |
| **4** | **PPTX 导出（薄版）** | 复用 | 选中产物 → 每张 1 全幅 slide，复用 frontend-slides 拼装机 | 低 |

**❌ 全局不做**（单机定位）：团队协作 / 权限、Canva 导出、持久化评论、社区画廊浏览。

**贯穿纪律**（实施期）：i18n(zh/en) / 禁硬编码（端点/价/常量入 `shared/constants.ts`）/ TDD / 新逻辑独立模块不堆 godfile / **新增 renderer→main IPC action 必须同步登记 `src/main/shellCapabilities.ts` 的 WORKSPACE 数组**（capability-diff 门）/ 改 prompt bump PROMPT_VERSION / 高风险（计费/协议/路径越界）走 codex-audit / 付费 dogfood 前提示成本 / 隔离 worktree。

---

## 1. 我的品牌契约（Brand Contract registry）

### 1.1 目标 / 非目标

**目标**：让用户把"我的品牌"（色板 / 字体 / 气质 / logo / **不要这样**）固化成一份可复用契约，强制注入**每一次**设计生成，跨生成保持一致——直接打"千篇一律 / slop"这个最响的痛点。

**非目标**（本期不做）：社区/公开画廊浏览（单机定位）；从用户代码库（tailwind.config/CSS 变量）自动抽 token（独立硬模块，留后续）；多人共享品牌库。

### 1.2 锚定的 as-built 事实（已逐一读码核实）

- **注入与护栏管线已现成，全在消费 `directionTokens`**——这是本件最大杠杆：
  - `src/main/app/workbenchTurnContext.ts` `buildWorkbenchTurnSystemContext` → `buildDesignBriefPromptPayload`（L221–249）把整个 `DesignBrief` `JSON.stringify` 进 `<design_brief_json>…</design_brief_json>` 系统提示；`enrichDesignBriefForPrompt`（L239–247）已会把 `directionTokens` 兜底填入、并把 `readDesignMdSummary(workingDirectory)` 合进 `references`。
  - `src/main/prompts/selfCritique.ts` `buildSelfCritiquePromptSection`（L51–73）+ `describeBriefAnchors`（L26–44）把 `palette.primary/surface/accent` + `fonts.serif/sans` + `posture` 当作 5 维自评锚点注入。
  - `src/design/critique/prompt.ts` `describeBrief`（L38–64）把 `directionTokens` 全色板 + 双字体 + posture 喂 VLM 打分（palette/typography/posture/surface/constraint）。
  - **→ 自定义品牌只要落进 `brief.directionTokens`（+ 扩展字段），这三处护栏全自动生效，无需新写注入逻辑。**
- **契约槽已存在**：`src/shared/contract/designBrief.ts` `DesignBrief.directionTokens?: DirectionTokens`（L46）+ `referenceScreenshot?: boolean`（L48，注释明写"参考截图模式：生成期需从附带图片提取配色/字体/布局并匹配"）。`DirectionTokens`（`src/design/direction-tokens.ts` L30–36）= `{palette{primary,surface,accent,muted,contrast oklch}, fonts{serif,sans}, posture, refs}`，6 个硬编码 persona。
- **真缺口（本件要补的）**：
  1. **brief 只活在内存**——`src/renderer/stores/sessionStore.ts` `sessionDesignBriefs: Map`（L993–1013），关会话即丢、不进 DB。"跨生成一致"必须有持久化。
  2. **`referenceScreenshot` 只是 flag、无真提取**——agent 靠看图手抽（`src/main/prompts/questionForm.ts` L44 prose），不稳定、不可复用。
  3. `~/.code-agent/design`（`workspace.ipc.ts` `handleResolveDesignDir` L39–43）下无 brand 存储；无 brand 选择/绑定 UI。
- **现成可复用后端**：`imageAnalyze`（`src/main/tools/modules/network/imageAnalyze.ts`，vision 分析工具）可作"参考图 → 抽色板/字体/类型"的提取后端（借鉴清单 L65/109 指定路径）。
- **OpenDesign 做法（林晨指定对标）**：`reference-design-contract` skill = 参考稿 → **Keep / Change / Do-not-copy** 三桶 → 可复用 **DESIGN.md** → registry 选中绑 **active DESIGN.md** → 生成期注入（借鉴清单 L65、L140 源索引；SKILL.md 本体未 vendored，仅借鉴清单转述，本 spec 据其落 Neo 法）。
- **不混淆**：`docs/designs/design-system.md` 是 **Neo 桌面 app 自身 UI 的治理契约**（primitives/token/CI 门），与本件"用户给生成产物用的品牌"是两层。本件命名一律用「品牌契约 / Brand Contract」，不用「design system」。

### 1.3 方案（2 选 1 + 推荐）

- **方案 A（推荐·已拍板·OpenDesign 式）**：品牌 = 一份 **Brand Contract**，结构 = `tokens(沿用 DirectionTokens 形状) + keep[] + change[] + doNotCopy[] + logo? + name`；两个录入口：① **从参考图提取**（vision 一次性抽 tokens → 用户审改 → 落盘，human-in-loop 防 slop）② **手填表单**。存成 **registry**（多个命名品牌，选一个 active）。生成期把 active 品牌 hydrate 进 `brief.directionTokens` + 新增 `brief.brandContract` 字段，复用现成三处注入/护栏。
- **方案 B（最小）**：只手填一个品牌 + 持久化 + 强绑，不做参考图提取、不做 keep/change/doNotCopy、不做 registry（单品牌）。最快但丢掉"从参考图固化品牌"这条 anti-slop 主卖点。

**推荐 A**：参考图提取复用现成 `imageAnalyze` + `referenceScreenshot` flag（半成品已有），keep/change/doNotCopy 是 OpenDesign 验证过的 anti-slop 结构且能直接喂进 critique 的 constraint 维度，边际工程小、叙事最强。

### 1.4 架构与数据流

**数据形状**（新增 `src/shared/contract/brandContract.ts`，纯类型 + normalize + 纯查询，可单测）：
```ts
interface BrandContract {
  id: string;              // registry key
  name: string;            // 'Porsche 数字化' 等
  tokens: DirectionTokens; // 复用现有形状（palette+fonts+posture+refs）
  keep: string[];          // 必须复刻：'圆角克制，大量留白'
  change: string[];        // 可调整：'主色可在深浅间浮动'
  doNotCopy: string[];     // 禁止：'不要渐变按钮，不要 emoji 图标'
  logoPath?: string;       // ~/.code-agent/design/brands/<id>/logo.png
  source: 'reference' | 'manual';
  createdAt: number; updatedAt: number;
}
```

**存储**（registry，单机文件，不进业务 DB）：
```
~/.code-agent/design/brands/
  index.json            # {activeId?: string, brands: BrandMeta[]}
  <id>/brand.json       # BrandContract
  <id>/logo.png         # 可选
  <id>/reference.png    # 可选，提取来源留档
```
- 选 registry 文件而非 DB：与 `design` 目录同处、单机自用、便于人读/手改/迁移；DB 用于会话/账本类强一致数据，品牌是用户配置性资产。

**新增 IPC（WORKSPACE domain，须登记 shellCapabilities）**：
| action | 入参 | 出参 |
|--------|------|------|
| `listBrands` | `{}` | `{brands: BrandMeta[], activeId?}` |
| `saveBrand` | `{brand: BrandContract}` | `{id}` |
| `deleteBrand` | `{id}` | `{ok}` |
| `setActiveBrand` | `{id\|null}` | `{ok}` |
| `extractBrandFromImage` | `{imagePath}` | `{tokens, keep?, doNotCopy?}` （走 vision/imageAnalyze 路径，一次性，提示成本） |

**注入数据流（强绑）**：
```
设置/选中 active 品牌 → setActiveBrand(id)
新会话/进设计模式 → 读 index.json.activeId → 载 brand.json
  → hydrate brief.directionTokens = brand.tokens（覆盖 persona 默认）
  → brief.brandContract = {keep, change, doNotCopy, logoPath}
→ workbenchTurnContext 序列化进 <design_brief_json>（扩 brandContract 段）
→ selfCritique + critique/prompt 把 doNotCopy/keep 追加进 constraint 维度锚点
→ 每次生图/原型生成都带这份契约（force-inject）
```
- **方向卡共存**：question-form 的 6 方向卡之上加一张「我的品牌」卡（active 品牌存在时置顶）；选它即等价 `direction=brand`，`renderQuestionFormToDesignBrief` 走 `brand.tokens` 而非 `directionTokens[direction]`。逃生口"直接生成"仍走 active 品牌（若有）。

### 1.5 文件清单（预计）
- 新增：`src/shared/contract/brandContract.ts`（类型+normalize+查询）、`src/main/services/design/brandRegistry.ts`（registry 读写+active 指针，独立模块）、`src/main/ipc/` 内 5 个 handler、`src/renderer/components/design/BrandManager.*`（registry UI：列表/手填表单/参考图提取/选 active）、品牌方向卡。
- 改：`src/shared/contract/designBrief.ts`（加 `brandContract?` 段）、`workbenchTurnContext.ts`（序列化 brandContract）、`selfCritique.ts` + `design/critique/prompt.ts`（keep/doNotCopy 进 constraint 锚点）、`question-form.ts` + `QuestionFormPreview.tsx`（品牌卡）、`shellCapabilities.ts`（登记 5 action）、`i18n/{zh,en}.ts`。

### 1.6 分期
- **B1 持久化 + 手填 + 强绑**（核心半边）：registry + 手填表单 + active 绑定 + 注入扩展。本期主体。
- **B2 参考图提取**：`extractBrandFromImage` 走 vision，提取→用户审改→落盘。付费（vision 调用），提示成本。
- **B3 critique 闭环增强**（可选）：doNotCopy 违反 → critique 低分 → 自动续编（借鉴清单"视觉 diff 闭环"，留后续）。

### 1.7 验收
- registry 增删改查 + active 切换纯单测；normalize/查询纯单测。
- 强绑：active 品牌存在时，连续 3 次生成的 `<design_brief_json>` 都含同一 tokens + doNotCopy（dogfood 抓系统提示）。
- 参考图提取：真图 → 抽出合理色板/字体（付费 vision，1 次）。
- critique：构造违反 doNotCopy 的产物 → constraint 维度低分。

### 1.8 收编与去重
本件**收编**借鉴清单二档「设计系统 registry（M2，含 brand-kit 复用）」+「参考稿→设计契约」两条欠账（清单 §2/§3 L64–65、L93）。实施后在借鉴清单标注合并。

---

## 2. PDF 导出

### 2.1 目标 / 非目标
**目标**：设计模式产物可一键导出 PDF——HTML 原型走矢量级打印，信息图/画布/设计稿（栅格）走图嵌 PDF。
**非目标**：PDF 编辑/批注；多产物合并成多页 PDF（薄版每产物 1 份，合并留 §4 PPTX/后续）；LibreOffice 路径（系统依赖、web 模式挂，不选）。

### 2.2 锚定的 as-built 事实
- **生产已装**（package.json dependencies 非 dev）：`playwright`、`pdfkit`、`pptxgenjs`、`sharp`。**无** puppeteer / pdf-lib（pdf-lib 仅在 `.agents/skills/frontend-slides` skill 内）/ jspdf / html-pdf。
- **无 `--print-to-pdf` 代码**，但 Playwright chromium `page.pdf()` 是教科书 HTML→PDF；`src/main/agent/runtime/browser/visualSmoke.ts` 已用 `loadPlaywrightChromium`（`src/main/runtime/playwrightRuntime.ts`）做 HTML→PNG，**运行时先例已存在**。
- **wrinkle**：chromium **不打进** Tauri bundle（`src-tauri/tauri.conf.json` 只 bundle audio-capture/vision-ocr/rtk/uv/pii），playwright 首用按需下载（~100MB+）。visualSmoke 已依赖此，须复用其 availability 降级路径（不可用时报可读错误，不崩）。
- **`saveTextToDownloads` 只收文本**（`src/main/ipc/workspaceSaveExport.ts` `handleSaveTextToDownloads` L12–31，`fs.writeFile(..., 'utf-8')`）→ PDF/二进制要**新加 `saveBinaryToDownloads`**。
- **WORKSPACE action 列表**在 `src/main/shellCapabilities.ts`（L320–349）；新 action 须登记。
- **原型在盘**：`~/.code-agent/design/<run>/prototype.html`（`findRunHtml` 优先 `prototype.*`）。**画布/标注 PNG**：`annotComposite.ts` `exportAnnotatedPng`（L70–154）→ `canvas.toDataURL('image/png')`；`DesignCanvas.tsx`（L439）`<a download>` 浏览器原生下载。
- **Tauri + webServer 同套 handler**（`src/web/webServer.ts` L738 `setupAllIpcHandlers` 复用 `src/main/ipc`，平台 mock 路由同代码）→ PDF 能力在两模式都注册，但 chromium 可用性两边都取决于本地 playwright（web 模式同样需要本地 chromium）。

### 2.3 方案（已拍板）
- **HTML 原型 → `page.pdf()`**：复用 `loadPlaywrightChromium`，`page.setContent(html, {waitUntil})` → `page.pdf({printBackground:true, format/preferCSSPageSize})` → 落盘/下载。矢量级、文字可选、体积小。
- **栅格产物（信息图/画布快照/设计稿 PNG）→ pdfkit**：`new PDFDocument`，按图原始宽高设页 + `doc.image(buf, {fit})` → 单页 PDF。pdfkit 已装、纯 Node、Tauri/web 双通、零 chromium 依赖。
- **新增 `saveBinaryToDownloads`** IPC（base64/Buffer → Downloads，重名加后缀，镜像现有 text 版）。

### 2.4 架构与数据流
**新增 IPC（WORKSPACE，登记 shellCapabilities）**：
| action | 入参 | 出参 |
|--------|------|------|
| `exportPrototypePdf` | `{html, outputName}` | `{filePath}` （主进程 playwright→pdf→存 Downloads） |
| `exportImagePdf` | `{imagePath\|dataUrl, outputName}` | `{filePath}` （pdfkit 图嵌） |
| `saveBinaryToDownloads` | `{fileName, base64}` | `{filePath}` （通用二进制落 Downloads） |

```
HTML 原型导出：DesignWorkspace 导出按钮 → 取 previewHtml（去注入态，与现 saveHtmlToDownloads 同源）
  → IPC exportPrototypePdf{html} → 主进程 loadPlaywrightChromium → setContent → page.pdf → saveBinaryToDownloads
画布/图片导出：选中节点 → 取 PNG（exportAnnotatedPng / 节点 src）
  → IPC exportImagePdf{dataUrl} → pdfkit 单页 → saveBinaryToDownloads
chromium 不可用：报「PDF 导出需要 Playwright Chromium，请…」可读错误，HTML 仍可导 .html 兜底
```
- **新逻辑独立模块**：`src/main/services/design/pdfExport.ts`（`htmlToPdf` via playwright / `imageToPdf` via pdfkit），不堆进 workspace.ipc.ts。

### 2.5 文件清单
- 新增：`src/main/services/design/pdfExport.ts`、3 个 IPC handler、renderer 导出菜单项（在现有 saveHtmlToDownloads 旁加「导出 PDF」）。
- 改：`workspaceSaveExport.ts`（加 saveBinaryToDownloads）、`shellCapabilities.ts`、`designFiles.ts`（renderer wrapper）、`DesignWorkspace.tsx`/`DesignCanvas.tsx`（按钮）、`i18n`。

### 2.6 验收
- `htmlToPdf` / `imageToPdf` 服务单测（mock playwright / 真 pdfkit 校验产物头）。
- dogfood：一份原型 → 矢量 PDF（文字可选中）；一张画布快照 → 图嵌 PDF；chromium 不可用时降级提示不崩。
- Tauri + web 两模式各验一次（web 模式确认 chromium 可用性表现一致）。

### 2.7 风险
- chromium 首用下载体积/时延 → 复用 visualSmoke 的 availability 检测 + 明确进度/降级，**绝不**静默卡死。
- `page.pdf()` 仅 chromium headless 有效（项目本就 chromium-only，无碍）。

---

## 3. 原型就地文本编辑（inline text edit）

### 3.1 目标 / 非目标
**目标**：HTML 原型预览里点文字直接改（contentEditable，免 AI），改动回写磁盘 `prototype.html`，即时落盘。premium 体验=改文案零 token、零等待。
**非目标**：图片产物（用不上，仅 HTML 原型有效）；改样式/布局（仅文本）；富文本/结构编辑（仅文本节点内容替换）。

### 3.2 锚定的 as-built 事实
- **注入脚本**：`src/renderer/components/design/designPreviewInject.ts` `injectSelectionScript` / `SELECTION_SCRIPT`（L22–57）；圈选发 `postMessage({source:'neo-design-proto'(PROTO_SELECT_SOURCE), type:'neo-design:select'(PROTO_SELECT_MESSAGE), payload:{tag,text,selector}})`；selector 走递归父链最多 6 层。**当前无 contentEditable。**
- **iframe 宿主**：`DesignWorkspace.tsx`（L888–897）`<iframe srcDoc={srcDoc} sandbox="allow-scripts">`；srcDoc = `injectSelectionScript(injectThemeOverride(injectPreviewStyle(previewHtml), palette), selectMode)`（L788–796）。**`allow-scripts` 已在**（contentEditable+脚本可跑）。
- **父侧监听**：`DesignWorkspace.tsx`（L768–781）`window message` → 校验 `e.source===iframe.contentWindow` + `parseProtoSelectMessage` → `setSelection` → `setSelectMode(false)`；圈选最终走 `continueEdit()`（useDesignGeneration）→ `dispatchToRun`→ **AI 重跑**（agent 用 Edit 工具改 prototype.html，见 `buildContinueEditPrompt`）。
- **canonical = 磁盘 `prototype.html`**：`writeWorkspaceFile`→`'writeFile'`；zustand `previewHtml` 是**只读镜像**。`handleRollback`（L758–766）即 `writeWorkspaceFile(proto, html)` 后刷新。**srcDoc 是被加工过的**（注了主题/滚动条/选择脚本）→ 内联改的文本必须按 selector 回写到**未注入的 canonical HTML**，不能存 srcDoc。
- **版本/spine**：`variantSpine.ts` / `protoSpine.ts`，`versions/v-<ts>.html` 追加快照 + `spine.json`；`captureVersion` 走 AI op/手动 checkpoint。
- **预览路径 = srcDoc**（非 dev-server）：`designPreviewInject.ts` L1–3 明注"设计原型是 srcDoc 沙箱单文件，没有 dev-server bridge（livePreviewSelection 那套依赖 vite 插件，这里用不上）"。内联编辑须走 srcDoc 路。
- 子 agent 评定**可行性高**。

### 3.3 方案（已拍板）
- **就地落盘、免 AI、不自动建 variant**：内联编辑直接按 selector 改 canonical `prototype.html` 落盘 + 刷新 previewHtml。
- **模式切换**：预览工具栏切「选区→AI 改」/「点字→直接改」两态，互斥（避免同一点击歧义）。
- **可手动存版本**：想留档时手动「存版本」走现有 `captureVersion`/snapshot。
- **新消息类型不冲突**：内联编辑脚本发 `{source:'neo-design-inline-edit', type:'neo-design:text-edited', payload:{selector, newText}}`；父侧独立 handler，仅在 inline 模式注册/响应，与圈选 handler 物理隔离。

### 3.4 架构与数据流
```
切到 inline 模式 → injectInlineEditScript 注入（替换/叠加 selectMode 脚本）
  脚本：文本元素 contentEditable=true + hover 提示；blur 时取 newText + 复用 path() 算 selector
  → postMessage {source:'neo-design-inline-edit', type:'neo-design:text-edited', payload:{selector,newText}}
父侧 inline handler（校验 contentWindow + 形状）
  → applyTextEdit(canonicalHtml, selector, newText)  // 纯函数：DOMParser 定位 selector → 替换文本节点 → 序列化
  → writeWorkspaceFile(prototype.html) → setPreviewHtml(刷新)
  → （可选）用户点「存版本」→ captureVersion
```
- **回写纯函数** `applyTextEdit(html, selector, newText)` 抽 `src/renderer/components/design/inlineTextEdit.ts`，可单测（selector 命中/未命中/多匹配/XSS 转义）。
- **安全**：`newText` 写回前转义 HTML 实体（防注入）；selector 多命中时取首个并提示；未命中静默忽略 + 不落盘。
- **与现有 selector 复用**：注入脚本的 `path()` 直接复用，保证圈选与内联用同一套 selector 语义。

### 3.5 文件清单
- 新增：`inlineTextEdit.ts`（回写纯函数）、`designPreviewInject.ts` 加 `injectInlineEditScript`。
- 改：`DesignWorkspace.tsx`（模式切换 UI + inline message handler + 落盘刷新）、`designStore`（inline 模式瞬时态）、`i18n`。**不新增 IPC**（复用 writeFile）。

### 3.6 验收
- `applyTextEdit` 纯单测（命中替换 / 转义 / 未命中不改 / 多匹配取首）。
- dogfood：原型点标题改字 → blur → 磁盘 prototype.html 对应文本变更 + 预览刷新 + 无 AI 调用；切回圈选模式仍正常走 AI 续编（两模式互不污染）。

### 3.7 风险
- selector 漂移（同类元素多）→ path() 已带 nth-child 兜底；多命中提示。
- srcDoc 加工层与 canonical 差异 → 回写**只认 canonical HTML**，srcDoc 仅预览，规避。

---

## 4. PPTX 导出（薄版）

### 4.1 目标 / 非目标
**目标**：把用户**勾选的若干设计产物**打成一份 PPTX，**每件 = 1 张全幅 slide**（mockup 打包给干系人的场景）。
**非目标**：从设计产物自动生成 deck 内容/文案（设计模式非 deck 形态，不硬拗）；用 `ppt_generate` 那套 markdown 驱动布局（它把图塞模板区域、非全幅，不适配）；信息图/原型自动拆页成多 slide。

### 4.2 锚定的 as-built 事实
- **`ppt_generate`**（`src/main/tools/modules/network/pptGenerate.ts`，pptxgenjs 4.0.1）= markdown 驱动、`images` 参数把图**区域放置**（一图一 slide 的模板槽，非全幅）。工具层（`ToolModule`，agent 可调）。**不适配** full-bleed 设计图。
- **`frontend-slides` skill**（`.agents/skills/frontend-slides/`）才有 full-bleed 拼装机：
  - `scripts/merge-to-pptx-hybrid.mjs`：N 张 PNG → 每张 `slide.addImage({x:0,y:0,w:'100%',h:'100%',sizing:cover})` **全幅** + 文字层叠加（L141–145、L225–260）。
  - `scripts/merge-to-pdf.mjs`：N 张 PNG → 1 PDF（pdf-lib）。
- **设计模式产物 = 单件**：`designCanvasTypes.ts` `DesignCanvasDoc{nodes: CanvasImageNode[]}` 是自由 2D 平面、非页序列；原型 = 1 页 HTML；信息图 = 1 图。**无 deck 形态**——故"自动成 deck"语义错配；但"勾选 N 件 → N 全幅 slide"是合理的人工打包。

### 4.3 方案（已拍板：薄版）
- 复用 `frontend-slides` 的 **merge-to-pptx-hybrid** 拼装逻辑（N 张全幅图 → 1 PPTX）：用户在画布/历史里**勾选若干产物**（图或原型快照 PNG）→ 按勾选顺序每张 1 全幅 slide → 出 PPTX。
- HTML 原型先经 §2 的 playwright 渲成 PNG（或截图）再入拼装，与图片产物统一为"N 张 PNG"。
- **薄**：不做文字层智能叠加（merge-to-pptx-hybrid 的 text overlay 这部分跳过或留空）、不做自动布局，就是"图 → slide"。

### 4.4 架构与数据流
```
画布/历史多选产物 → 收集 N 张 PNG（图节点 src / 原型经 playwright 截图 / 画布快照）
→ IPC exportSelectionPptx{images: string[](路径或 dataUrl), outputName}
→ 主进程 services/design/pptxExport.ts：复用 merge-to-pptx-hybrid 核心（pptxgenjs，每图全幅 addSlide+addImage）
→ saveBinaryToDownloads（§2 已建）
```
- **复用决策**：把 `merge-to-pptx-hybrid.mjs` 的"图→全幅 slide"核心抽成可被主进程调用的服务函数（pptxgenjs 已是生产依赖）；skill 脚本是 `.mjs`、属技能层，主进程不直接 spawn skill，而是**抽共享纯逻辑**进 `src/main/services/design/pptxExport.ts`（尊重工程层/技能层分层）。
- 若评估发现抽取成本 > 价值，**降级**：不在设计模式内置 PPTX，文档注明"需要 deck 时让 agent 调 frontend-slides skill"。

### 4.5 文件清单
- 新增：`src/main/services/design/pptxExport.ts`（图→全幅 PPTX，复用 pptxgenjs）、`exportSelectionPptx` IPC handler、renderer 多选 + 导出 PPTX 入口。
- 改：`shellCapabilities.ts`、`designFiles.ts`、画布/历史多选 UI、`i18n`。

### 4.6 验收
- `pptxExport` 服务单测（N 图 → N slide，全幅校验：python-pptx 结构断言，沿用 ppt 测范式）。
- dogfood：勾 3 件 → 3 全幅 slide PPTX，PowerPoint/Keynote 打开正常。

### 4.7 风险 / 取舍
- 价值偏 niche（mockup 打包），列在四件最末；若实施期抽取 merge 逻辑成本偏高，按 §4.4 降级为"走 skill"并在文档说明，不强行内置。

---

## 5. 实施顺序建议（待拍板）
1. **§2 PDF**（快赢，建 `saveBinaryToDownloads` 也是 §4 前置）
2. **§1 我的品牌契约**（最战略，B1 持久化+手填+强绑 → B2 参考图提取）
3. **§3 就地文本编辑**（看方向，独立小件）
4. **§4 PPTX 薄版**（复用 §2 的 saveBinary + frontend-slides 拼装，最末）

每件独立 worktree + 独立 PR，按 §0 纪律实施；高风险（PDF/品牌注入/路径越界）走 codex-audit；付费（参考图 vision 提取）dogfood 前提示成本。
