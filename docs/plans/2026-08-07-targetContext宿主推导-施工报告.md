# 施工报告：`targetContext` 改推导（工单名"宿主推导"，实际落在渲染端）

工单：`code-agent-private-archive/docs/plans/tickets/2026-08-07-targetContext-宿主推导-工单.md`
日期：2026-08-07　｜　基点：`origin/main` @ 0f038c221（#1018 已合）

## 结论先说

工单的**目的**（把 `targetContext` 从模型手里拿走）成立且已达成，但**落点和论据都被读代码推翻了**：

| 工单原计划 | 实际做的 | 为什么变 |
|---|---|---|
| 推导落在宿主 `extractToolCallMeta`，要改 7 个调用点 + 扩 AST 静态契约门 | 落在**渲染端** `ToolHeader`，**1 个调用点**，provider 侧零改动 | 只有渲染端消费 `targetContext`；宿主侧不需要它，持久化它没有消费者 |
| 新建一张工具名→kind 推导表 | 复用现成的 `classifyToolName`，只加一张 **13 行**的 category→kind 映射 | 渲染端早就有这张工具名表了 |
| 论据：「模型能填对的宿主也能推，填不对的填了也是错」 | 论据更强：**四种非 app 的 kind，可见产出只是一个由 kind 唯一决定的 12px 图标**，`label` 从不作为可见文字渲染 | 见 §2.1 |
| 第 1 步要真机看流式行为 | **没跑真机**，改成用例钉住 | 换落点后"流式期间图标出不来"这个问题不存在了；见 §3.2 |
| 未提及 | **额外改了提示词** `TOOL_ENVELOPE_CONVENTIONS` + bump `PROMPT_VERSION` | 工单漏了这个缝；见 §2.2 |

净收益：**约 1.8K input token/请求**（schema 1,628 + 提示词 164），
且模型不再有机会把 kind 填错。

净改动：4 个生产文件 + 2 个测试文件（1 新建 1 改）+ 1 个新建测试。

---

## 1. 第 1 步量化（三项）

### 1.1 WebSearch 到底算不算 browser

工单要求"去看 `TargetContextIcon` 渲染出来长什么样再定"。看了，结论比这个问题本身更重要：

```
kind === 'app'         → NSWorkspace 真 app logo / emoji 映射 / Monitor 兜底
kind === 'browser'     → <Globe size={12} aria-label={label || 'Browser'} />
kind === 'mcp_server'  → <Plug size={12} .../>
kind === 'file'        → <FileText size={12} .../>
kind === 'memory'      → <Brain size={12} .../>
```

**四种非 app 的 kind，可见产出就是一个 12px 定长字形，`label` 只进 `aria-label`。**
全仓 grep 确认 `targetContext.label` 没有任何一处被渲染成可见文字
（`ToolHeader.tsx:94` 是唯一的 `TargetContextIcon` 使用点）。

所以"WebSearch 算不算 browser"这个问题降级成"要不要给网络类调用一个地球字形"。
**判 browser**：对非程序员协作者，"这一步出网了 vs 在本地读文件"是有意义的区分，
而 shortDescription 是一句话不是字形，扫读时字形更快。

### 1.2 流式期间的图标行为

工单要求真机跑。**换落点后这个问题消失了**，没跑真机——理由见 §3.2，
改成用例钉住"工具名已知、arguments 还空着"这个流式形态。

### 1.3 推导表要多大才够

工单说"别写 50 个工具的全表"。实际连表都不用写——渲染端的
`humanizeToolStep.ts` 里已有 `classifyToolName`，把工具名（含 `read_file`
这类历史小写别名和 `mcp__server__tool` 前缀）映射到 25 个 category。
推导只需要一张 category→kind 映射（13 行）。

拿这张现成的表跑真库（2026-07 起 5,357 次调用）：

| kind | 调用数 | 占比 |
|---|---|---|
| browser | 1,976 | 36.9% |
| file | 1,448 | 27.0% |
| mcp_server | 29 | 0.5% |
| **无图标** | 1,904 | 35.5% |

**无图标是正确行为不是缺口**：其中 Bash 独占 1,118（20.9%）——Bash 的目标是一条
命令，不是可图标化的实体，那正是 `shortDescription` 存在的理由。今天模型在这些
工具上填的 kind 全是瞎猜（`Bash`→file/app、`AskUserQuestion`→app/file/memory）。

**没做的部分（如实写）**：落进 `unknown` 的工具里有几个是真该有 kind 的——
`ListDirectory` 97 次、`ExcelAutomate` 65、`MCPUnified` 54、`Browser` 52、
`Blob` 28、`image_analyze` 18、`ppt_generate` 13、`MemoryWrite` 12。
它们缺的是 `classifyToolName` 的集合登记，补进去会**同时改 `humanizeToolStep`
生成的句子**（那是另一条产品文案线），超出本工单范围，没动。
⚠️ 顺带发现：`ListDirectory` / `Blob` / `Append` / `MemoryWrite` / `MemoryRead`
都是 `CORE_TOOLS`，却不在 `classifyToolName` 的任何集合里——也就是说它们的
**工具行人话文案今天也是走通用兜底的**。这是既有缺口，不是本批引入的，已记下。

---

## 2. 量化/读码推翻了什么

### 2.1 工单的论据偏弱，真论据是"label 根本不渲染"

工单立论是"模型填得不准，宿主推得准"。读完 `TargetContextIcon.tsx` 后发现更硬的一条：
**四种非 app kind 的信息量上限就是"哪一类"，因为只有字形会被看见**。
既然如此，让模型每次调用花 74 token 去描述一个"由工具名唯一决定的类别"，
无论它填得准不准都是浪费——**准确率只是附带改善，token 才是主因**。

反过来，`app` kind 是唯一带真信息的（NSWorkspace 真 app logo，靠 `iconHint`=bundleId），
而它本来就由 `cuaNarration` 在宿主侧推导，不依赖模型。所以拿掉 `targetContext`
对 app 图标零影响。

### 2.2 工单漏了一个缝：提示词也在教这个字段

`src/host/prompts/builder.ts` 的 `TOOL_ENVELOPE_CONVENTIONS` 里有**两个完整 JSON
示例 + 一段 5 条 kind 规范**在教模型填 `targetContext`（实测 164 token）。
只删 schema 不删提示词的后果：提示词教一个 schema 里没有的字段，
**OpenAI strict function calling 会直接报错**，且白烧 token。

已同步删除，并按仓库既有硬门 bump `PROMPT_VERSION`（`sys-v20` → `sys-v21`）——
这道 pre-commit 门是施工中被拦下才发现的，拦得对（telemetry 靠它按版本归因失败率）。
新增一条契约用例钉住"提示词与 schema 同增同减"。

### 2.3 落点从宿主改到渲染端

工单指定改 `extractToolCallMeta`（7 个调用点：`openaiWrapper` ×2、
`anthropicWrapper`、`geminiWrapper`、`claudeProvider` ×2）。核查后发现：

1. **宿主侧没有任何 `targetContext` 消费者**——全仓 grep，`src/host` 下只有
   生产它的 `cuaNarration` 和搬运它的 `toolCallMeta`/`shared`，消费方全在
   `src/renderer`，唯一渲染点是 `ToolHeader.tsx:94`。持久化一个没人读的推导值
   没有意义。
2. 那 6 个 wrapper 调用点**都不经过** `buildToolCallFromAccumulator`（cua 兜底和
   `generateFallbackShortDescription` 就挂在那儿）——所以宿主侧落点要么改 7 处，
   要么把推导塞进 `extractToolCallMeta` 并给它加参数。
3. 渲染端落点只需 1 处，且**自动覆盖历史落库的行**（老数据没有 targetContext 的
   现在也有图标了），不需要任何迁移。

---

## 3. 实际改动

### A. `src/host/model/providers/shared.ts`
`META_PROPERTY_SCHEMA` 删掉 `targetContext`：182 → **108** token
（OpenAI 路径过 `normalizeJsonSchema` 后 192 → **113**）。
× 22 个核心工具 = **省 1,628 token/请求**。常量注释写明为什么能删、以及
`expectedOutcome` 为什么不能照着删（自由文本，推导不出来，真库填充率 39.5%）。

### B. `src/host/prompts/builder.ts` + `src/shared/constants/agent.ts`
删掉两个 JSON 示例里的 `targetContext` 行和 5 条 kind 规范（**省 164 token/请求**），
`PROMPT_VERSION` bump 到 `sys-v21`。

### C. `src/renderer/utils/humanizeToolStep.ts`
新增 `deriveToolTargetContext(name, args)`：

```ts
const kind = TOOL_CATEGORY_TO_TARGET_KIND[classifyToolName(name)];
if (!kind) return undefined;            // 不许兜底成默认 kind
const label = targetLabelFor(kind, name, args);
return label ? { kind, label } : { kind };
```

`label`（file→basename、browser→hostname、mcp→server slug）只为 `aria-label`
保留——可访问性不能因为"反正看不见"就省掉。

### D. `ToolHeader.tsx`
```ts
const targetContext = toolCall.targetContext ?? deriveToolTargetContext(name, args);
```
宿主推的 app kind 和历史落库行优先，推导只兜底。

**没动**：`extractToolCallMeta` 仍照常读 `_meta.targetContext`——模型若自发填、
或历史消息里有，照收不误。这条路径删掉会白丢兼容性，留着零成本。

---

## 4. 门与变异

### 五道门

```
npx tsc --noEmit                    EXIT=0
node scripts/tsc-tests-ratchet.mjs  current=0 baseline=0 delta=0     EXIT=0
node scripts/eslint-ratchet.mjs     errors 0/0，warnings 416/416     EXIT=0
node scripts/knip-ratchet.mjs       2684（基线 2687），低于基线 3 处  EXIT=0
npx vitest run tests/scripts        33 files / 247 tests             EXIT=0
```

外加 pre-commit 的 `PROMPT_VERSION` 门（施工中被它拦下一次，见 §2.2）。

CI PR 档 vitest 子集（照 `swarm-ci.yml` 真实参数，另加 `tests/unit/model`、
`tests/unit/prompts`）：**1669 文件 / 14007 用例，13981 过、0 条断言失败**，
1 个**文件级**失败：`mediaAssetLightbox.browser.test.ts` 的 `afterAll` 关浏览器/server
超时（10s hook timeout）。单跑该文件 **6.9s 通过**。

⚠️ 这次**没有**跑 `origin/main` 零改动 worktree 的同组合对照（上一批做了）。
理由：它是跑真浏览器 + HTTP server 的 teardown 超时，与本批改动面
（`_meta` schema / 提示词 / 工具行文案推导）零交集，且 0 条断言失败。
**这是一次有意识的降级判定，不是"跑绿了"**——最终以 CI 为准。

### 新增用例

`tests/renderer/utils/deriveToolTargetContext.test.ts`（表驱动，加一行多一条用例）：
23 行取样按真库调用量从高到低覆盖 browser / file / mcp_server / memory /「无目标」，
外加两条底线：

- **底线①**：未登记的工具返回 `undefined`，不许兜底成默认 kind
  （`TargetContextIcon` 对未知 kind 会渲染 MessageCircle 兜底图标，
  返回 `{kind:'unknown'}` 会让每个没登记的工具长出一个聊天气泡）
- **底线②**：不产出 `app` kind（那是 cua 的地盘，渲染端拿不到 bundleId，
  抢着推只会把真 app logo 降级成 Monitor 通用图标）

`tests/renderer/components/toolHeader.targetIcon.test.tsx`（真渲染，jsdom）：
推导渲染 / 流式态（工具名已知、args 还空）/ **优先级** / 无目标工具不长图标。

`providers-shared.metaBudget.test.ts`：上限 190→**115**（OpenAI 205→**125**），
字段断言从三个字段改成两个，并新增"提示词与 schema 同增同减"一条。
注释里写明了**这是那条字段完整性断言唯一一次合法放宽**，以及为什么
`expectedOutcome` 不能拿它当先例。

### 双向变异（四轮，每轮先 assert 变异目标存在）

| 变异 | 预期 | 实际 |
|---|---|---|
| 推不出 kind 时兜底成 `'file'` | 「无目标」用例 + 底线① 转红 | **9 条红**；还原后绿 |
| `ToolHeader` 优先级反过来（推导覆盖宿主值） | 优先级用例转红 | **第一次全绿 —— 门没守住**，见下 |
| `targetContext` 加回 schema | 体积门 + 字段断言转红 | **3 条红**（108→144、113→154）；还原后绿 |
| 提示词里把 `targetContext` 教回去 | 同增同减用例转红 | **1 条红**；还原后绿 |

🔴 **变异 2 第一次是绿的，这是本批最值得记的一条**：原来那条优先级用例用
`computer_use` 做样本，而 `computer_use` 推导出的是 `undefined`——
`A ?? B` 和 `B ?? A` 在 B 为 undefined 时结果相同，**两种优先级都能过**。
换成"两边都有值"的形态（`Read` + 历史 `targetContext`）后才真的钉住，
重跑变异 2 转红。**钉优先级的用例，样本必须两边都有值，否则是空断言。**

### 守不住的部分（如实写）

- **`deriveToolTargetContext` 的覆盖面完全绑定 `classifyToolName` 的集合**。
  没登记的工具（ListDirectory / Blob / MemoryWrite / ExcelAutomate / MCPUnified /
  Browser 等，2026-07 起合计约 350 次调用）拿不到图标。这是 fail-safe 不是崩，
  但别把 64.5% 的覆盖率读成"都覆盖了"。
- **没有门盯着"新工具进了 `classifyToolName` 却没进 kind 映射"**。
  新 category 落到映射外 → 无图标，静默降级。加这道门需要穷举 `ToolCategory`
  联合类型，`Partial<Record<...>>` 改成全量 `Record` 就能让编译器盯住——
  没做，因为那会逼着给 `bash`/`askUser` 这类明确无目标的 category 写
  `undefined` 占位（13 行变 25 行的噪声）。**这是有意识的取舍，不是遗漏。**
- **没跑真机**。§1.2 的流式问题因换落点而消失，用 jsdom 真渲染 + 流式形态用例
  替代。但"图标在真实应用里长什么样、密度会不会太吵"没有真机证据——
  这一条如果要，得单独看一眼。
- `label` 只有 `aria-label` 一条消费路径，**没有测试断言它被屏幕阅读器读到**，
  只断言了 DOM 上有这个属性。
