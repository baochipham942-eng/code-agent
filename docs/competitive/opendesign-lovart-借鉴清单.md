# OpenDesign + Lovart → Neo 设计模式借鉴清单

> **来源**：nexu-io/open-design（open-design.ai，真引擎）· manalkaff/opendesign（prose skills 包）· Lovart.ai（设计 agent）
> **调研方式**：3 轮并行子 agent（repo 源码 sparse-clone 实测 + 社区/VoC + UI/UX 跨工具 + Neo as-built 锚点 + Neo 可达图像 API 核查）→ 阶段 5 多模型对抗评审（codex + 2× Claude skeptic 共 3 票，Gemini/antigravity 端点失败缺位）
> **生成日期**：2026-06-21
> **对照产品**：code-agent / Neo 设计模式（canvas PR#257 + proto v0 已合 main + src/design）

---

## 0. 去魅定性（别被 README/营销唬住）

| 产品 | 一句话本质 | 被去魅掉的营销点 |
|---|---|---|
| **Open Design (nexu-io)** | 真引擎：Next.js + daemon + 24 个 CLI 适配器，自己不写编码内核 | "259 skills" 实为 ~159 文件夹、95% 是 1.2KB 广告 stub；"261 插件" 142 个是设计系统换皮 |
| **opendesign (manalkaff)** | 纯 markdown skills 包，**零源码零运行时**，写给 LLM 的 prose | "image generation / 视频 / MP4" 全是营销，0 实现 |
| **Lovart** | 设计 agent = 编排层 + 模型路由 + 语义编辑 UX，**自己不做任何模型** | "图片变清晰 / Ultra-HD Upscaling" 是营销空气（仅 SEO 页有，changelog 无实现） |

**三家共同的真空白**：真 mask inpaint 之外的精确一致再编辑、纯抠图/分割、图床/CDN 公网 URL（全 local-only）。

---

## 1. Neo 已领先、别往回抄（防倒退）

as-built 已用独立 context 的 Explore agent + codex 读真实代码交叉核验：

- **真图像编辑闭环**：`wanx2.1-imageedit` 真 mask inpaint（canvas, `imageGenerationService.ts:314` editImageWithMask）+ A/B 版本对比（`DesignCompareOverlay.tsx`）+ 圈选标注。Lovart 自承做不好"精确再编辑"，opendesign 两家完全没有。
- **真图像处理**：`imageProcess`（convert/compress/resize/upscale via sharp）+ `imageAnnotate`（OCR+SVG）+ `imageAnalyze`（vision）。opendesign B 全无，A 的 skills 层是 stub。
- **critique 引擎已落地**：`src/design/critique/`（5 维）+ DESIGN.md loader + 6 direction-tokens。
- **单体架构无"静默能力悬崖"**：Open Design 只有 Claude Code 后端能真区域 patch、弱适配器会冲掉无关改动且 UI 无提示；Neo 单体自用天然没这问题。

→ **图像操作这条线 Neo 本就领先**。借鉴是"补精度与编排"，不是"补能力有无"。

---

## 2. 借鉴清单（5 要素 + 文件锚点）

每条：对方做法 / 我方现状(有·部分·无 + 锚点) / 缺口 / 借鉴动作 / 改造成本。

### 图像操作（Neo 可达 API 实测）
> `wanx2.1-imageedit` 一个模型靠 `function` 枚举覆盖：`expand`(扩图) / `super_resolution`(超分) / `remove_watermark`(消除去水印) / `stylization_all`·`stylization_local`(风格迁移) / `colorization`(上色) / `doodle`(线稿) / `description_edit`(免 mask 指令编辑) / `description_edit_with_mask`(已用)。统一异步 endpoint（提交+轮询 task_id），0.14 元/张。**Neo 持 DashScope key，边际成本极低。**
> ⚠️ 对抗评审修正：现有 `submitAndPollWanx`（`imageGenerationService.ts:244`）是通用 helper（~70% 可复用），但每个 function 各有参数 schema（expand 要方向比例、super_resolution 无 prompt、stylization 有风格枚举）+ 需各自 wrapper + UI 触发 + 异步轮询接线。**是"加 wrapper 级"工程，不是字面"改一个枚举值"——别低估。**

| 操作 | 对方 | 我方现状 | 借鉴动作 | 成本 |
|---|---|---|---|---|
| **扩图 expand** | Lovart 招牌 | 无 | wanx `function=expand` + 方向/比例 UI | 低 |
| **消除/去水印 remove_watermark** | Lovart Remover | 无 | wanx `function=remove_watermark` | 低 |
| **超分 super_resolution** | Lovart 营销空气 | 无 | wanx `function=super_resolution`，**先过质量门再当卖点**（别继承 Lovart 的 upscale 不信任） | 低 |
| **风格迁移 stylization** | Lovart Style Consistency | 无 | wanx `stylization_all/local` | 低·**低频 demo 级** |
| **上色 colorization** | — | 无 | wanx `function=colorization` | 低·低频 |
| **改字（图内文字替换）** | Lovart 旗舰但中文崩 | 无 | `description_edit` 指令编辑 / 高质走 FLUX.2；提字用智谱 `GLM-OCR`（0.2 元/百万 token） | 中·**CN 文字=差异化** |
| **抠图/透明前景** | Lovart 一键、被夸 | 无（canvas 仅手画矩形 mask `designCanvasMask.ts`） | 需新接 **阿里云视觉智能 `SegmentCommonImage`**（独立产品/key） | 中·唯一真新接入 |

### 编排与编辑 UX（Lovart）
| 能力 | 对方做法 | 我方现状 | 缺口 | 借鉴动作 | 成本 |
|---|---|---|---|---|---|
| **能力感知模型路由 + @-mention** | 先匹配内部 LoRA/preset 库命中走便宜专用、未命中回退大模型；@Flux 手动指定 | 引擎判定散在 `imageGenerationService` 硬绑 | 无 capability-tag 路由 | 抽路由注册表（绑设计系统）+ @-mention 覆盖 | 中·**对 solo BYOK 是隐形 plumbing，静默建** |
| **Touch Edit 语义选择**（点物体免画 mask） | AI 自动分割物体→自然语言改 | 仅手拖矩形 mask | **需语义分割**（Neo 0 分割能力，grep 无 SAM/segment） | **绑分割前置**（=抠图同一接入），选择只是 30%，核心是配合一致性锁定 | 高·**依赖陷阱见 §4** |
| **语义分层 PNG→PSD**（Edit Elements） | 平图拆主体/背景/文字层+生成式补背景 | 无 | — | 后续，依赖分割 | 高 |

### 设计风格 / 系统（OpenDesign）
| 能力 | 对方做法 | 我方现状 | 借鉴动作 | 成本 |
|---|---|---|---|---|
| **方向卡 + 贴参考截图入口** | `question-form.ts` direction-cards（色板+双字体+mood+refs 一卡）+ 建项目"Match a reference screenshot"分支 | 有 `ask_user_question` 工具 + `DesignBrief` schema，但**设计流未接线**（`designExecutor` 无澄清环） | 接线成 mandatory 澄清表单 + 方向卡 + 参考入口 | 低·**anti-slop 最便宜杠杆** |
| **设计系统 registry + 画廊** | 文件夹/品牌注册表，live 卡=`<iframe srcDoc={components.html}>`，选中绑 active DESIGN.md | 仅 6 个硬编码 direction-tokens；DESIGN.md 只读 | registry（**含 brand-kit/asset 复用 + 跨尺寸一致**，见 M2）；gallery 浏览半延后 | 中 |
| **参考稿→设计契约** | `reference-design-contract` skill（Keep/Change/Do-not-copy→可复用 DESIGN.md） | 无提取链路 | 参考图→`imageAnalyze` 抽 palette/type→写 DESIGN.md→生成期强制注入 | 中 |
| **critique 视觉 diff 闭环** | PR#3660 渲染 HTML→截图→比参考→回灌 critique | critique 后置单向（`critique/critique.ts`） | 改成"截图 vs 参考"打分 + 不达标自动续编 | 中 |

### 确定性控制（OpenDesign，绕开慢 agent 回路）
| 能力 | 对方做法 | 我方现状 | 借鉴动作 | 成本 |
|---|---|---|---|---|
| **Tweaks 运行时换肤** | `runtime/srcdoc.ts` HSL 色相偏移注入预览 iframe，零重生成 | 无 | 预览侧 CSS 变量/HSL 覆盖。⚠️**仅对 proto HTML 有效，canvas 栅格 PNG 无效**（确认） | 低·限 proto |
| **seed 真图占位** | taste-skill prose + lint：`picsum.photos/seed/{desc}/{w}/{h}`，禁灰框 | 原型配图无真图策略 | 抄 prompt 规则 + 一条 lint | 低·去灰框 |
| **Inspect 实时改 CSS** | `srcdoc.ts:833` 确定性 CSS 覆盖面板，可 commit 回源码 | 无 | 加 Inspect 直改面板 | 中·solo 价值中 |
| **Picker→硬 scope-lock 注入** | postMessage 桥 + `<attached-preview-comments>` 硬 scope-lock | proto 已有 picker→续编 | 借 scope-lock 范式防越界重写 | 低 |

---

## 3. PM 三档分类（对抗评审后·终版）

> 评审纪律：升/降档均标注票数。3 票 = codex + skeptic1(代码锚点) + skeptic2(产品价值)。

### ✅ 第一档·立即做（trust + anti-slop + 真低成本）
1. **变体/版本并排对比 = 非破坏性 variant spine**　〔skeptic2 升至 #1：全场最大白地、信任层、串起所有 op〕— 每个 op 写新 pinned variant 永不覆盖。⚠️ proto 侧仅复用 canvas A/B ~15%（仅 flex 布局），是真工程非白嫖。
2. **扩图 expand + 消除 remove_watermark**　〔skeptic2 拆包：保留这两个 workhorse〕— wanx function，真低成本。
3. **一致性锁定再编辑（M1）**　〔skeptic2 新增·关键〕— region-lock + diff-gate 证明未选区域逐像素不变（或感知 ε 内）。**正面打 Lovart 头号软肋**；复用现有 mask inpaint + Picker scope-lock。
4. **方向卡 + 贴参考截图入口**　〔skeptic2 从二档升一档〕— anti-slop 最便宜杠杆，OpenDesign 已证、当前是 table-stakes 欠账。
5. **成本透明 + undo/redo 信任 UI（M3）**　〔skeptic2 新增〕— BYOK 每次调用 commit 前显示 ¥/token + 每 op 可逆命名历史步。把 Lovart 计费+静默破坏两个软肋变差异化。
6. **Tweaks 换肤（限 proto）+ seed 真图占位**　— 确定性反 slop，零/低 API。

### 🟡 第二档·中工程
7. **Touch Edit 语义选择 + 抠图（SegmentCommonImage）**　〔codex+skeptic1 从一档降二档·依赖陷阱〕— 二者共用分割前置，必须一起、且在再编辑之后。
8. **能力感知模型路由 + @-mention**　〔skeptic2 降序：solo BYOK 隐形 plumbing，静默建〕。
9. **设计系统 registry（含 brand-kit/asset 复用 + 跨尺寸一致 M2）**　〔skeptic2 拆分：registry 留、gallery 浏览半延后〕。
10. **参考稿→设计契约 + critique 视觉 diff 闭环**　；**改字（CN 差异化）/ 语义分层 PNG→PSD**　；**Inspect live-CSS**〔skeptic2 降级 live-CSS、保 critique 半〕。
11. **风格迁移 / 上色 / 超分**　〔skeptic2 从一档降：demo 级低频；超分先过质量门〕。

### ❌ 不建议 / 低优先
- **图床 / CDN 公网 URL**　— VoC 信号薄（扫 40 PR 0 条相关抱怨），三家都没做，solo 自用无需。
- **自研像素模型**　— Lovart 都不做，路由现有模型即可。
- **设计系统 gallery 社交浏览半 / 多人协作向**　— SaaS flavor，solo 无用。

---

## 4. 依赖陷阱（阶段 5 专项纠出）

1. **Touch Edit（一档#2 原位）→ 依赖 分割能力（二档抠图）**　〔codex + skeptic1 双票·代码实锤〕：Neo 全库 0 分割（grep 无 SAM/segment），canvas 仅手画矩形 mask（`designCanvasMask.ts`）。"点物体免 mask" **不可能在没有分割时落地**。→ 已下放二档，与抠图捆绑，排在一致性再编辑之后。
2. **一致性锁定再编辑（M1）→ 依赖 现有 mask inpaint + Picker scope-lock**（已具备）→ 可直接进一档。
3. **proto 并排对比 → 依赖 variant 数据模型统一**：canvas 有（canvas.json node tree），proto 需新建 ~85%（versions/*.html + meta，无 choose/discard 工作流）。
4. **设计系统画廊 → 依赖 registry 先建**；**参考→设计契约 → 依赖 imageAnalyze 抽取链路**（半成品已有）。
5. **超分当卖点 → 依赖 质量验证门**：未验证前别广告，否则继承 Lovart upscale 的不信任。

**第二票兜底**：Gemini（antigravity）端点本轮失败，其对抗票由 codex 顶替；codex 与 skeptic1 在"Touch Edit 依赖分割"上独立同票，结论稳。

---

## 5. 一句话结论

原清单优化的是"接线便宜"，结果是**抄了 Lovart 的功能面、却继承它三个软肋**（精确再编辑 / 中文文字 / 计费信任）。对抗评审把重心翻成**三条无人攻克的信任车道**：**变体对比 spine + 一致性锁定再编辑 + 成本/undo 透明**，再叠 anti-slop 最便宜的方向卡——这才是 Neo 能赢的地方。图像操作走 wanx function 廉价补全（扩图/消除优先，风格/上色/超分降级），抠图是唯一真新接入且为 Touch Edit 的前置。

---

## 源索引

- Open Design A：`skills/reference-design-contract/SKILL.md`、`apps/web/src/artifacts/question-form.ts`(direction-cards)、`runtime/srcdoc.ts`(HSL换肤/pod/inspect)、`edit-mode/bridge.ts`+`comments.ts:444`(scope-lock)、`apps/daemon/src/media/{models,index}.ts`、`runtimes/registry.ts`、`skills/taste-skill/SKILL.md:296`(seed图)、PR#3660(视觉diff)
- opendesign B：`skills/{opendesign,create-design-system}/SKILL.md`
- Lovart：lovart.ai/changelog、/features/touch-edit-ai、36kr.com/p/3296149075216391(创始人)、uisdc.com/lovart(路由)、trustpilot 1.5 / producthunt 4.9(VoC)
- Neo 可达图像 API：help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference（function 全枚举）、SegmentCommonImage(viapi)、智谱 GLM-OCR、OpenRouter FLUX.2
- Neo as-built：`src/main/services/media/imageGenerationService.ts:244/314`、`src/renderer/components/design/{DesignCanvas,DesignCompareOverlay,designCanvasMask}`、`src/design/{design-md-loader,direction-tokens,critique}`、`src/main/plugins/builtin/{imageProcess,imageCreation}`、`shared/contract/{designBrief,question}.ts`
