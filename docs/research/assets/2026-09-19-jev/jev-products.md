# TypeSafe Jev 发布后：产品/公司级动作（截至 2026-09-19）

检索范围：Jev 于 **2026-09-15** 由 TypeSafe CEO Diogo Almeida（@CompleteSkeptic）发布；官方博文同日。本文只收录**产品/公司/知名开源项目**的官方或核心成员公开表态与已上架证据。个人小仓库一律不写。查不到写「未查到」，不编造。

发布原句（2026-09-15）：
> After co-inventing ChatGPT… we are releasing today: Jev • 20-200x faster • 40-400x cheaper (w/ output tokens free)
> — https://x.com/CompleteSkeptic/status/2099925682726002904

博文：「Think of Jev as a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out.」  
https://typesafe.ai/blog/introducing-system-one-models-and-jev （2026-09-15）

四天里真正「产品级」落地的模式很窄：没有人宣布用 Jev 替换主对话模型。已上线的都是把分类、路由、护栏、浏览器点选从 LLM 调用里拆出来。下文按层标注：路由 / 审批 / 压缩 / 判官 / 检索 / 浏览器动作。截至检索日，**压缩、判官、检索**没有公司官方发版；只有社区插件在做。

---

## 1. MAKA / Maka Agent：没有「围绕 Jev 重构 Maka」的官方帖

**Apache Maka 产品本身：未查到。**  
官网 https://maka.apache.org/en/ 与仓库 https://github.com/apache/maka 的 README / 架构文档，检索 **Jev / TypeSafe** 无命中。没有时间表、没有「哪一层用 Jev」、没有已上线开关。

**创始人 kabikabi（@jakevin7，bio 含 maka-agent.com / OpenCLI）有表态，但对象是 OpenCLI，不是 Maka 产品重构：**

| 日期 | 原句 | 来源 |
|------|------|------|
| 2026-09-17 | 「Jev 太屌了！！！完全是模型的新方向+新范式。…用 OpenCLI 配合了下 Jev，爽到飞起。」 | https://x.com/jakevin7/status/2100530193538695565 |
| 2026-09-17 | 有人问 OpenCLI 会不会采用、至少 as an option？回复：「当然会！next step! OpenCLI 正在大重构ing」 | https://x.com/jakevin7/status/2100532658065580428 |
| 2026-09-17 | 「jev在memory上真的大有可为！」 | https://x.com/jakevin7/status/2100598165837901958 |

同日另一条「刚刚在做重构的方案design，三个模型一起跑相同的prompt，fable真的惊艳啊！」是用 Fable 做设计，**未点名 Jev、也未点名 Maka**（https://x.com/jakevin7/status/2100639755570704758）。

**结论：** 用户印象「maka agent 都提到要重构」与公开记录不完全重合。jakevin7 同时维护 Apache Maka（本地 agent harness）和 OpenCLI（浏览器 CLI）。能钉死的只有后者：**OpenCLI 将接 Jev（至少作 option）、正在大重构**；接在哪一层未写死，问答上文是「有人把它用在 Browser 上，OpenCLI 会采用吗」，因此更像**浏览器动作**，不是 harness 全文重写。Maka 的 SelfCheck / verifier / 权限决策 / 上下文压缩是否换成 Jev：**未查到**。时间表与是否已上线：**未查到**。若只凭创始人兴奋帖推断「Maka 产品已围绕 Jev 重构」，证据不够。

注意：X 用户 @MKantautas 显示名也是 Maka，但是个人开发者，与 Apache Maka 无关；他 9/18 写「haven't found any yet for my existing projects」，不能算产品官方。

---

## 2. 各家产品：谁接了、接在哪一层

### 已有官方/核心成员公开动作

**Vercel（AI Gateway / AI SDK）— 路由、继续/停止、评分、护栏；已上线**  
- Changelog（约 2026-09-16）：「Choosing the next tool or subagent… continue, retry, ask the user, or stop… Scoring urgency… Verifying model outputs and enforcing guardrails。」模型 `typesafe-ai/jev`，走 experimental `evaluate`。https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway  
- 官方博客：「By hour 24, it was being used by nearly 13% of paid teams. That’s 2x as many as the GPT-5.6 family and over 6x as many as Fable 5.1.」https://vercel.com/blog/ai-gateway-jev-model-launch  
- @vercel 2026-09-18：「Jev was adopted faster than any other model in AI Gateway history.」https://x.com/vercel/status/2101077346203971900  
- @vercel_dev 2026-09-19：「Jev … is free on Vercel AI Gateway until Sept 25.」https://x.com/vercel_dev/status/2101116818463281579  
- CTO Malte Ubl 2026-09-16：对既有分类 eval，「It won both on quality (saturated the eval) and speed (6x)」。https://x.com/cramforce/status/2100269198727602468  
- TechCrunch（2026-09-18）转述 Vercel 工程师：安全分类比 Luna 5.6 快 5–18 倍。https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/

**Cloudflare（Workers AI + AI Gateway）— 结构化评估；已上线**  
- VP Rita Kozlov 2026-09-17：「update: jev is live on @cloudflare ai gateway」。https://x.com/ritakozlov/status/2100688919364845709  
- 文档模型 id `typesafe/jev`，`env.AI.run`，Noul/Choice/Score。https://developers.cloudflare.com/ai/models/typesafe/jev/

**OpenRouter — Decisions API（分类/路由/工具选择）；beta 已上线**  
- 官方 2026-09-18：「Jev by @typesafeai is now on OpenRouter, in beta.… There is no JSON prompting, parsing layer, and nothing to validate against.」https://x.com/OpenRouter/status/2100744709589316009  
- 同日：「Faster agent tool calls. … Jev could pick the right tools…」https://x.com/OpenRouter/status/2101061712392901115  
- 目录：`typesafe/jev-1.13`，`POST /api/alpha/decisions`，$0.042 / $0。https://openrouter.ai/typesafe/jev-1.13

**LangChain / LangGraph — 路由 + 工具风险审批；SDK 已上，产品内嵌未宣布 GA**  
- 官方博文 2026-09-17 *Building a Harness with Jev*：`TypeSafeClassifier`；`ModelRouterMiddleware`（**路由**）；`AutoModeMiddleware`（工具调用前 **审批/护栏**）。https://www.langchain.com/blog/building-a-harness-with-jev  
- 文档：https://docs.langchain.com/oss/python/integrations/providers/typesafe  
- CEO Harrison Chase 2026-09-18：「jev has sparked more internal demos and exploration of how we can use it in our product than any other model launch / its not even close」。https://x.com/hwchase17/status/2101095843096912100  
- 官方号预告下周 livestream。https://x.com/LangChain/status/2101077173604143503  
- 员工 Nathan Drezner：LangChain + Jev 做 **browser use**（维基竞赛/订机票）。https://x.com/ndrezn/status/2101046780989215005

**Dify — 问题分类器（工作流分支路由）；已上插件**  
- 核心成员 @beautyyuyanli 2026-09-18：「@dify_ai now supports to use Jev from TypeSafe AI in our classifier node!」插件 https://marketplace.dify.ai/plugin/langgenius/typesafe_ai  
  https://x.com/beautyyuyanli/status/2100913383143026873  
- 官方 @dify_ai：「Jev by @typesafeai is now available in Dify’s Question Classifier node. Use a model designed for structured decisions to route inputs across your workflow branches.」https://x.com/dify_ai/status/2100919627656433685

**Browser Use — 浏览器动作（operation + DOM target）；开源 demo 已上**  
- 创始人 Gregor Zunic 2026-09-17：「Breaking: Browser Use + Jev = Ultrafast ⚡ Findings flights took 7s and cost only $0.0039」。https://x.com/gregpr07/status/2100411066966749359  
- 仓库 https://github.com/browser-use/jev-ultrafast （Copyright 2026 Browser Use）。Jev 选操作+元素，小 LLM 只在 `TYPE_TEXT` 时写字。**不是把主产品全面换成 Jev**，是官方实验/开源 agent。

**OpenCLI — 浏览器动作，承诺重构中、尚未见发版说明**  
见第 1 节 jakevin7 原句。未查到 OpenCLI 文档/release notes 已合入 Jev。

**TypeSafe 自己给 coding agent 的 skill（不是 Anthropic/OpenAI 官方接入）**  
https://docs.typesafe.ai/agent-skill ：`claude plugin marketplace add typesafe-ai/skills`。这是 **TypeSafe 向 Claude Code / 其他 agent 分发 skill**，Anthropic、OpenAI、Cursor、Codex **官方账号未表态**。

**Netlify AI Gateway（清单外，但是公司级上架）**  
Changelog 2026-09-17：「TypeSafe’s Jev model is now available through Netlify’s AI Gateway with zero configuration required。」https://www.netlify.com/changelog/typesafe-jev-ai-gateway/

### 未查到官方/核心成员公开表态或已接入

Manus、Genspark、Flowith、Lovart、扣子/Coze、CrewAI、OpenAI Agents SDK、Anthropic（Claude Code / Agent SDK 官方）、Cursor、Codex、Windsurf、Devin、Replit、Perplexity、Kimi/月之暗面、智谱、DeepSeek、MiniMax、阿里通义/Qwen Agent、字节 Trae、腾讯元宝/CodeBuddy、Hermes（Nous 官方）。

说明：
- **n8n**：有社区 node（https://github.com/DomMonte/n8n-nodes-typesafe-ai）和社区模板；**@n8n_io 官方未查到**。README 写 Cloud 需 n8n 审核，目前偏自托管。
- **Hermes / Nous**：仅社区 skill（如 hermes-jev-skills），@Teknium / @NousResearch **未查到**背书。
- Higgsfield AI 官方 2026-09-19 写「Jev is really good at content filtering and asset selection」——清单外，层=内容过滤/素材选择。https://x.com/higgsfield_ai/status/2101117855622463719

**层位汇总（只计官方已写明的）：** 路由——Vercel、OpenRouter、LangChain middleware、Dify 分类节点；审批/护栏——Vercel changelog、LangChain AutoMode、Vercel 自用安全分类；浏览器动作——Browser Use 官方仓库、OpenCLI 创始人承诺；评分——Vercel / Cloudflare 文档示例。压缩、检索、独立「判官」产品化：**未查到公司发版**（社区有 compaction / 对抗评审插件，不算本清单）。

编码 agent 全家桶（Cursor / Codex / Windsurf / Devin / Replit / Claude Code 官方）目前的姿态是「旁路 skill 可装」，不是产品声明要重构 agent loop。TypeSafe 自己的 skill 明确写给 Claude Code 与 `npx skills add`，这是供应商往下游塞文档，不是下游官方接入。

---

## 3. 云平台与网关分发、定价是否一致

官方标价（TypeSafe docs，查于 2026-09-18）：**输入 $0.042 / MTok，输出免费**；限额 250,000 tok/s、1,200 RPM。https://docs.typesafe.ai/models

| 渠道 | 是否上架 | 模型 id | 标价 | 备注 |
|------|----------|---------|------|------|
| TypeSafe 直连 | 是（early access / waitlist） | `jev-latest` → `jev-1.13.0` | $0.042 / $0 | 官方 |
| Vercel AI Gateway | 是（changelog ~09-16） | `typesafe-ai/jev` | 目录 **$0.04/M**；**至 2026-09-25 免费** | 与官方差 $0.002；促销不一致 |
| OpenRouter | 是（09-18 beta） | `typesafe/jev-1.13` | **$0.042 / $0** | 与官方一致；单一 provider=TypeSafe；Decisions API 非 chat |
| Cloudflare Workers AI / AI Gateway | 是（09-17） | `typesafe/jev` | 文档指向 dashboard；models.dev 列 **$0.04 / $0.00** | 公开页未钉死 $0.042 |
| Netlify AI Gateway | 是（09-17） | 走 `@typesafe-ai/sdk` | 计入 Netlify credits | 未公布单价 |
| AWS Bedrock | **未查到** | — | — | — |
| Azure | **未查到** | — | — | — |
| Together | **未查到** | — | — | — |
| Fireworks | **未查到** | — | — | — |

**定价不完全一致：** 直连与 OpenRouter 对齐 $0.042；Vercel/Cloudflare 第三方目录出现 $0.04 四舍五入；Vercel 还有一周免费促销。OpenRouter 页面写「hosted by one provider… forwards every request to it directly」。

---

## 4. 竞品「System One / 决策模型 / RLCD」与开源仿制背书

- OpenAI、Google、Anthropic、Mistral、国内大厂：**未查到**宣布同类 System One / RLCD 产品。独立站点 2026-09-18：「Jev is the first and, as of 18 September 2026, only System One model on the market.… Who else sells a System One model? Nobody。」https://systemonemodels.org/guides/what-is-a-system-one-model/
- TechCrunch 2026-09-18：「For now, Jev stands alone as this kind of model, but Ronacher expects that competitors will spring up。」
- 开源仿制（Kev / NanoJev / OpenJev / jev-on-a-laptop 等）**全部自称 independent / not affiliated**。例：OpenJev README「It is not affiliated with or endorsed by TypeSafe AI。」TheoLeeCJ/openjev 已改名 SemIf，并写「not affiliated with or endorsed by TypeSafe」。NanoJev 是 0.6B 个人 replica。Codiv 给 OpenJev 提供免费托管，那是推理平台，不是实验室背书。**未查到 OpenAI / 云厂 / 国内大厂给任何仿制站台。**
- 个人推测「DeepSeek/Qwen 年内会出类似」**不是官方**。RLCD 无论文、无数据集，仿制目前只复现接口（state + typed questions），不复现训练。

---

## 5. 负面 / 观望：没有产品级「不接」声明

**未查到**任何清单内产品公开说「不接 Jev」。能核实的摩擦：

1. **准入与限额。** 直连仍是 waitlist + early access；官方限额 1,200 RPM / 250k tok/s。网关是绕过 waitlist 的主路径。
2. **准确率/校准争议（社区，非产品声明）。** 独立测试称 ECE 高于噪声地板；OpenRouter 自家 workflow eval 的「正确答案」是 GPT-6 Astra 与 Fable 5.1 的平均，不是人工标注。这是方法论质疑，不是「不接」。
3. **数据出境 / 单一供应商。** Vercel 示例打开 `zeroDataRetention`，但**没有**中国厂商以合规为由拒绝的原文。上游目前只有 TypeSafe 一家。
4. **能力边界。** 官方：无文本生成、无多模态输入。游戏/开放动作场景有人测输给 Gemini Flash Lite——个人评测，不是产品否决。

n8n 社区有人喊「needs a Jev node immediately」；Manus 仅有路人「should integrate asap」——都不是官方观望声明。

观望的实质更像**渠道未通**而不是**产品否决**：直连要排队，限额紧，API 形态是 Decisions 而不是 chat completions，现有 agent SDK 不能只改 model 字符串。网关（Vercel / OpenRouter / Cloudflare / Netlify）降低了这一摩擦，所以「已接」几乎都发生在网关和分类节点，而不是把 Manus / Cursor 一类完整 agent 产品拆开重做。中国厂商沉默，不能解读成「明确不接」；同样不能解读成「已经在接」。

---

## 置信度低 / 未核实

- Cloudflare dashboard **精确单价**未打开登录页，仅有 docs「View pricing in the Cloudflare dashboard」与 models.dev 的 $0.04。
- Vercel「13% of paid teams」是 Gateway **用量渗透**，不等于把生产 agent 决策层换成 Jev。
- LangChain Chase 的「internal demos… in our product」**未说** LangSmith 已默认开 Jev。
- OpenCLI「大重构ing」无 PR/发版交叉验证；Maka 仓库未搜到 Jev。
- Browser Use `jev-ultrafast` 是官方开源实验，**未核实**是否写入 Browser Use Cloud 主路径。
- Dify 插件已宣布，**未核实** Cloud 全区域默认可调、以及是否必须自备 TypeSafe key。
- 国内大厂「未查到」受搜索语言/微信公众号墙限制；若只发了国内渠道，本报告可能漏检。
- 检索截止 **2026-09-19**；发布仅四天，后续官方帖可能很快出现。
