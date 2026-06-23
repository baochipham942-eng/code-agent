# 实施计划 · 统一设计偏好记忆

> 来源：竞品借鉴(Alma)项④。架构师蓝图 + 艾克斯对抗审计 + 注入点实地调查。
> 定位：Agent Neo = cowork 人机协作产品。借的是 typed 设计偏好记忆抽象，**不是** Alma 对话记忆；绝不自动写记忆（人主导）。
> 生成日期：2026-06-23　状态：**蓝图地基错位，需按本文修订重做后再实施（建议第三，⑤①之后）**

## ⚠️ 关键修订：注入地基错位（实地调查实证）
原蓝图假设统一注入点是 `enrichDesignBriefForPrompt`——**错**。实地追踪三条生成路径证实：`enrichDesignBriefForPrompt` **只被 `buildWorkbenchTurnSystemContext`(workbenchTurnContext.ts:46) 调用一处，只服务通用 chat**。设计 tab 三条生成路径**全部绕过它，各自拼 prompt**：

| 路径 | 真实 prompt 组装(文件:行) | 品牌当前注入 | 偏好该挂哪 | 经 enrichDesignBrief |
|---|---|---|---|---|
| A 原型 | `buildPrototypePrompt()` designTypes.ts:128 | 无契约，仅 UI form brandColor/tone/surface（session designBrief 可 prepend contract） | renderer `dispatchToRun()` 经 context.designBrief 下传，或参数化 designContext | 绕过 |
| B 画布出图 | `buildImagePrompt()` designTypes.ts:217 | 仅 brandColor/tone，无契约 | 扩 BuildImagePromptInput 传 brandId/偏好，函数内查表注入 | 无关 |
| C 演示稿 | 主题由 `resolveTheme()` slidesGenerator.ts:36（大纲 buildOutlinePrompt slidesAiOutline.ts:23） | resolveTheme 品牌→主题映射，无契约 | 加 preferredTheme 参数覆盖默认主题 | 无 |

**结论**：没有单一注入点。"统一偏好注入"=三条各自落点。且品牌契约在设计路径上本就基本空缺（仅原型经 session designBrief 承载），所以**记忆范围要诚实缩小到轻量项（主题/模型/风格偏好），别假装能统一注入 contract**。

## 架构决策：适配层 Option A（不迁移品牌存储）
品牌存储一行不改（getActiveBrandSync 同步读稳定）。新建 `designPreferenceRegistry` 存 `~/.code-agent/design/design-prefs.json`（与 brands/ 同级）。其他偏好以 typed entry 存。

## 数据模型
`src/shared/contract/designPreference.ts`（新建）：DesignPrefEntryType = 'model-pref'|'style-pref'|'output-pref'|'project-context'（**brand-ref 删掉，见修订**）。DesignPreferenceIndex{schemaVersion:1, entries:[]}。

## 🔴 艾克斯对抗审计修订（必须并入重做）
1. **[HIGH] 注入点重做**（见上表）：Phase3 从"改 enrichDesignBriefForPrompt"改为"三条路径各自落点"。这是重做核心。
2. **[HIGH] PPT 注入漏空**（slidesGenerator.ts:36）：新偏好须进 SlidesDeckInput/resolveTheme（preferredTheme 参数），不能只改 brief。
3. **[HIGH] 别压垮品牌护栏**（brandInjection.test.ts:58）：style-pref 兜底若写进 directionTokens/brandContract 会压掉品牌 doNotCopy 护栏。兜底必须只补"用户未填且品牌未提供"的空位，且不进 brandContract 字段。
4. **[MED] brand-ref 删除**（brandRegistry.ts:101/232）：会制造第二个 active 真源与 brands/index.json.activeId 漂移。**MVP 直接 reject/strip brand-ref**，品牌仍 BrandManager 管。
5. **[MED] readPrefsSync read-your-writes 竞态**（brandRegistry.ts:130/253）：刚存完偏好立即生成可能读旧文件。须给 read-your-writes 口径（写后失效缓存 / 同步落盘后再返回）。
6. **[MED] model-pref 覆盖 store 破坏 localStorage 语义**（designStore.ts:104/223）：须明确**只 seed 空值**或用户显式"应用偏好"，不静默覆盖已持久化的 surface/outputType/imageModel 等。
7. **[MED] project-context 跨项目污染**（workbenchTurnContext.ts:241）：无 scope 会把上个项目的 audience/constraints 悄悄带入。MVP **project-context 绑 workingDirectory scope 或直接不做**。
8. **[MED] shellCapabilities 一致性**（shellCapabilities.ts:320）：手写 manifest，漏登记也能过测。新增 handler 须补 handler↔manifest 一致性测试。
9. **[LOW] model-pref 类型不干净**：带 videoModelId/videoMode 却漏 videoDurationSec，形成半套迁移。收编范围要么完整要么砍到 imageModel/surface/outputType。
10. **[LOW] 注入噪声无上限**：normalizeStringList 只 trim/dedupe 不限长。prefs 的 constraints/tones 须限长，防 prompt 膨胀。

## 缩小后的 MVP（综合修订）
- 只做 **model-pref（imageModel/surface/outputType 完整）+ style-pref（direction/tones 限长）**。
- **project-context 砍掉**（修订 7，价值未验证 + 污染风险）。
- **brand-ref 砍掉**（修订 4）。
- 注入：B 画布出图 + C 演示稿主题先落地（改 buildImagePrompt + resolveTheme 参数，确定性强）；A 原型经 session designBrief 落地（修订 3 护栏）。

## 分步（重做后）
- Phase0 **重新摸清 + 定稿三线注入设计**（本文已给地图，需细化每条改动点）
- Phase1 contract + registry + 测试（纯加法，brand-ref/project-context 已砍）
- Phase2 IPC + shellCapabilities（含一致性测试，修订 8）
- Phase3 三线注入（B/C 优先，A 次之，全程守修订 3/5/6/7/10）
- Phase4 UI DesignPreferenceManager + i18n

## 净评
④ 不是不做，是**现在按原蓝图做会白写**（注入地基错位）。本文已把注入地图 + 10 条修订并入，重做时以此为准。优先级排第三，⑤① 之后。
