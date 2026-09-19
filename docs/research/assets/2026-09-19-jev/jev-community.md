# TypeSafe Jev 社区检索笔记（截至 2026-09-19，只收录第三方/社区，不复述官网）

检索范围：X 原生帖串、GitHub README、独立博客与评测仓。日期一律用帖子/提交时间。找不到即标「未查到」。

---

## 1. X / Twitter 一手讨论

### @jakevin7（kabikabi）

主帖 https://x.com/jakevin7/status/2100530193538695565（2026-09-17）：「Jev 太屌了！！！完全是模型的新方向+新范式。……用 OpenCLI 配合了下 Jev，爽到飞起。以后其他大规模召回、AI推荐系统、实时交易，都可以用这个模型。」约 15.9 万浏览、86 条回复。

同作者次日 https://x.com/jakevin7/status/2100598165837901958（2026-09-17）：「jev在memory上真的大有可为！」

回复串（thread_fetch 只回了高互动几条；keyword 补了同 conversation）：

- @leon7hao（2026-09-17）：「softmax is all you need」
- @PredmetCh（2026-09-17）：「以及网络安全领域的大批量告警日志分析研判、PII数据分级分类等。……jev搞的RLCD是好东西，通过不对称的算力需求来平衡攻防成本。」
- @zack80349105（2026-09-17）：「是不是有点吹过了？这玩意儿就是用language-> structured output做了定向训练。……模型本身并不是多模态的，仍然依赖语言输入」
- @wubin28（2026-09-18）：「以后写Agent循环里"判断下一步做什么""给候选打分""路由到哪个分支"这类高频小决策,不用再老老实实调一次贵还慢的LLM再解析文本了,直接甩给Jev」
- @longniaox（2026-09-18）：「这玩意不应该拿来聊天，应该塞到各种系统里当决策层」
- @Bk1man（2026-09-18）：「这里最想确认的是评测口径：Jev 的 95.9% 准确率、超越 GPT-5 的 3%，你们的数据是否包含生产环境真实流量上的对照测试」
- @pochenai（2026-09-18）：「我看好多人不理解，说没啥用，不就是10几年前玩剩下的分类器吗」

其余 80 余条回复未全量抓到（thread_fetch 截断）。

### @Saccc_c 四场景帖 + 四条原帖

四场景帖 https://x.com/Saccc_c/status/2100833094291087773（2026-09-18）：「强烈建议大家都亲自试试Jev，能让你的Codex操作速度提高10倍并省下大量token！……能在毫秒内做出正确判断……1、computer use 将Jev用作操作判断层……2、上下文压缩……3、模型路由……4、自动审核 比5.6 luna还要便宜且精准……使用的话要去官网申请，趁现在还通过的很快」

同作者后续 https://x.com/Saccc_c/status/2100864907046768890（2026-09-18）：「我尝试用Codex+Jev打造了一个加强版computer use，我称之为「Jev Use」。……「添加Mac日历事件」……Jev版本整体过程几乎无任何停顿」

四条被引原帖（t.co 短链本次未能解析 Location，作者与内容与场景一一对应）：

1. **computer use / @gregpr07** https://x.com/gregpr07/status/2100411066966749359（2026-09-17）：「Breaking: Browser Use + Jev = Ultrafast ⚡ / Findings flights took 7s and cost only $0.0039 🤯 / > new action space every step / > DOM state space / > small LLM fallback to type / (this video is at 1x speed btw)」
2. **上下文压缩 / @tamarajtran** https://x.com/tamarajtran/status/2100694549362553153（2026-09-17）：「found the perfect use case for @typesafeai Jev: instant compaction / in 2026, why is compaction still a summarization prompt? / Jev can make it instant by scoring every tool call and dropping what’s irrelevant」；仓库帖：「run fast-jev-compaction: https://github.com/tamaratran/fast-jev-compaction」。后续 https://x.com/tamarajtran/status/2100742069753176533：「Jev’s context window is only 32k tokens while a Claude conversation can reach 200k tokens or more!」
3. **模型路由 / @mdlahfir** https://x.com/mdlahfir/status/2100314182201802811（2026-09-16）：「Jev solved local harness/model routing / … routing to other harnesses was always enforced in the system prompt/rules / … Mechanical tasks get routed to Haiku / Intelligent ones to Opus sub-agents / Long-running implementation work to external harness」
4. **自动审核 / @fazxes** https://x.com/fazxes/status/2100300097695232164（2026-09-16）：「We benchmarked fx auto mode (safety) classifier with @typesafeai's Jev. / tl;dr: ~5-18x faster and more accurate than gpt-5.6-luna, our current top choice」。配图原文：「70 labeled cases × 3 runs … TypeSafe Jev Accuracy: 207/210 (98.6%) Median: 312 ms p95: 374 ms / Gateway LLM (… openai/gpt-5.6-luna) Accuracy: 203/210 (96.7%) Median: 1,458 ms p95: 6,583 ms / Jev was 4.7x faster at median, 17.6x at p95, with zero fallbacks in 210 decisions and perfect run-to-run consistency (70/70 cases identical 3/3; the LLM flapped once).」

@theo 对压缩的反驳（yibie 也点名）：https://x.com/theo/status/2100762304862384257（2026-09-18）被社区索引为「This is a terrible compaction strategy」；tamarajtran 回复：「That’s not specific to jev compaction. Summarize based compaction has the same issue」。theo 原帖全文本次 thread_fetch 未展开到正文，只确认存在且 yibie 记为 2,276 赞。

### @yibie《Jev 怎么用：三种提问原语与分层阈值》

**未查到**该标题帖（X keyword、web search 均无命中）。yibie 同期实际帖是 awesome-jev 巡检，不是用法教程。

可核帖：

- https://x.com/yibie/status/2100619188062523695（2026-09-17）：「我按「Jev 到底在做什么决策」整理了公开可查的项目与讨论，目前收录 46 条」
- https://x.com/yibie/status/2101095525793616162（2026-09-18）《Jev 生态 72 小时：从 46 条到 160 条》：「Jev 把「判断」变成了一个足够便宜、可以在代码里直接调用的原语。」「tamaratran/fast-jev-compaction 现在 3,169 星……实测 Claude Code 从 156,000 tokens 压到 62,000」。「@jiayuan_jy：……「这好像就是一个更快的通用分类器，LLM 完全可以做到」」。「@anderslie：Jev 快的关键不是训练而是推理技术（并行解码）」。「@iwashi86：用约 1 万次 API 调用反推 Jev 内部结构」。「160 条里有大量 0 星、一天写完的仓库，README 里的数字也不一定有出处。」

**未查到** yibie 自称「本机复现了开源同类实现并做了准确性对照」。本机 logits 复现见 kuhung（第 3 节），不是 yibie。

### @0xLogicrw Awesome Jev（截图 4 条之后抓全）

原清单帖 https://x.com/0xLogicrw/status/2100478725393686556（2026-09-17），配图是 waitlist 通过邮件「You're in!」。正文 14 条（不仅 4 条）：

1. jev-ultrafast — 「Jev 负责每一步判断「做什么、点哪个元素」……Google Flights 搜航班完整跑完约 7.1 秒。」https://github.com/browser-use/jev-ultrafast
2. typesafe-mcp — 「Agent 可以随时调用 Jev 做 Choice / Score / Noul」https://github.com/itsmostafa/typesafe-mcp
3. jev-mcp — 「已经封装好事实核验、Prompt Injection 检测和语义排序。」https://github.com/jkudish/jev-mcp
4. SemDecide — 「做成 Unix 命令行工具」https://github.com/sharziki/semdecide
5. Jev Codex Router — 「先让 Jev 判断每一轮编程任务有多难……237 个真实 turn 回放，自测成本降低约 60%。」https://github.com/0xNatoshi/jev-codex-router（45★，最后推送 2026-09-17）
6. Winnow — 「给 Claude Code 做「上下文垃圾回收」」https://github.com/GhalebDweikat/winnow（17★，2026-09-19）
7. Jev Review — 「先判断 correctness、security、reliability、兼容性和测试风险」https://github.com/devagrawal09/jev-review（269★，2026-09-17）
8. Blink — 「每到一层目录，就判断哪些文件或文件夹最可能和问题有关」https://github.com/ellipsis-dev/blink（17★，2026-09-16）
9. neo4jev — 「Jev 给每条候选边打概率，再用 beam search」https://github.com/jexp/neo4jev（20★，2026-09-18）
10. jev-desktop — 「读取 Accessibility Tree，判断该操作哪个控件」实际仓 https://github.com/lahfir/agent-desktop（1273★，2026-09-17）
11. TypeSafe AI Playground — PHI/注释/语气实验 https://github.com/markjaquith/typesafe-ai-playground
12. Prism — 「默认还是 shadow/advisory，不直接驱动交易。」https://github.com/irfndi/prism-liquidity-agent
13. 1v1 Jev — 「让 Jev 大约 9Hz 判断移动、瞄准、ADS、开枪和跳跃。」https://github.com/emrickgarrett/OneVOneJev
14. TypeSafe on Neon（后改名 Safer with Jev）— 「请求先由 Jev 判断属于哪种任务」https://github.com/andrelandgraf/typesafe-on-neon

收束句：「就是拿它反复做「要不要、选哪个、打几分、下一步干什么」。真正需要生成代码、写文章和复杂推理时，再把任务交给传统大模型。」

次日 https://x.com/0xLogicrw/status/2100861912590205411：「导航站已经上线：https://logicrw.github.io/awesome-jev-projects/ ……增加到 130+ 个」。2026-09-18 仓库 `src/data/projects.json` 实际 **167 条**。作者自限：「The first 14 projects are pinned: true」；「Browser Flights 7.1s is the author's narrow example, not a general benchmark. / Router ~60% is an author replay cost estimate. / All projects have runtimeVerified: false。」

167 条无法在字数内逐条引用；完整 JSON：https://raw.githubusercontent.com/logicrw/awesome-jev-projects/main/src/data/projects.json 。15 号之后高星增量包括 fast-jev-compaction（当时清单 2645★）、pg-jev、jev-review（Niaz）、pi-jev、jev-browser 等。大量 1★ 条目摘要被雷达写成套话，作者自己警告不可当实测。

### @vista8 调研结论与飞书文档

https://x.com/vista8/status/2100591235471966472（2026-09-17）：「这两天最火的新构架大模型 Jev，官方Waitlist填写地址 / Vercel AI Gateway已经可以调用……很多朋友在聊，但具体应用场景还需要挖掘。」评论自回：「官方申请Waitlist地址 https://typesafe.ai/」

结论帖 https://x.com/vista8/status/2100775218830815554（2026-09-18）：「Jev模型的Waitlist提交后没多久就通过了。也用Codex调用成功，但还没想到具体应用场景。」「「零幻觉」其实是指「零类型/结构错误」，不能理解为语义正确。最合理的用法：把 Jev 当成超高速、可校准的语义判断/打分引擎，不是替代现有 LLM。」配图标题《Jev 模型全网调研结论（简版）》，作者「乔向阳 / 今天修改」。截图第一节原句：「Jev 是 TypeSafe AI 推出的首个 System One Model（系统一号模型），属于「机器原生决策模型」，不是聊天 LLM。」「Jev：完全放弃字符串生成 → 只输出 Noul/Choice/Score 三种原语，理论上不会类型错误或输出非法字段，也没有自然语言幻觉问题。」「一句话：把「超大聊天模型」变成「超强语义 if 分支 / 打分器」。」

**飞书/doubao 全文：未打开。** 推文以「原文」收尾，X 工具未返回可点 URL；web search 未命中 `feishu.doubao.com` 公开链。只能依据截图第一节 + 推文三点。@bookingX0 回复：「零幻觉那个说法确实容易误导人，第一次看差点以为是语义层面的保证」。

---

## 2. GitHub 适配器 / 项目

星数与最后提交以 `gh api` 2026-09-19 查询为准。

### browser-use/jev-ultrafast

- **★5563**，最后提交 2026-09-18 `1231850`「docs: announce the Cloud waitlist below the README title」
- 用法：`uv sync` + `TYPESAFE_API_KEY` / `TEXT_MODEL_API_KEY`，`uv run jev`；库接口 `Agent(url, goal)`。
- **Jev 负责哪一步：**「TypeSafe's Jev picks an operation and an element. A small LLM writes text only when the operation is TYPE_TEXT。」一次请求同时出 operation + target。
- 宣称数字（README / docs/performance.md）：「Zürich → London on Google Flights in 7.1 seconds。」录像 **7,073 ms**；「Median Jev latency was **178 ms**.」六次交替跑 median **9.450 s → 7.092 s**（25%）；「Three pairs are too few for a strong statistical claim」。成本数字在 README 未写，$0.0039 来自 @gregpr07 帖，不是仓库自己的表。

### itsmostafa/typesafe-mcp

- **★69**，最后提交 2026-09-18 `0c9f35d`
- 用法：`evaluate setup mcp` 注册进 Claude Code / Desktop / Codex；也支持 `OPENROUTER_API_KEY`。
- **Jev 负责：** 唯一工具 `evaluate`，「sends state plus typed questions to Jev and returns structured answers with probabilities。」
- 速度/成本：README **未给**延迟或单价；只写「429 and 529 responses are retried」。

### jkudish/jev-mcp

- **★73**，最后提交 2026-09-18 `89f88b9`
- 用法：`npx -y @jkudish/jev-mcp`；八个工具 `jev_verify / screen / find / rerank / classify / decide / compare / extract`。
- **Jev 负责：** 各工具内部的 typed judgment（核验、注入筛查、语义选/排、分类等）。
- 宣称：「in roughly 150 to 500 ms, for a fraction of a cent。」无独立对照表。

### sharziki/semdecide

- **★5**，最后提交 2026-09-16 `33cf5c0`
- 用法：`semdecide is/choose/score/filter/guard`；`export TYPESAFE_API_KEY`。
- **Jev 负责：** 「Jev returns typed decisions」；本地代码管阈值、退出码、`allow/escalate/block`。
- 速度/成本：README **未给**毫秒或美元数字。示例 `TRUE probability=0.860 threshold=0.700`。

### 清单里还提到、本次核过的仓

| 仓 | ★ / 最后推送 | Jev 角色 | 自称数字 |
|---|---|---|---|
| tamaratran/fast-jev-compaction | 3256 / 2026-09-18 | 给每条 tool call/result 打分，决定删或留原文 | yibie 转述 156k→62k tokens（作者帖，非本仓独立复现） |
| lahfir/agent-desktop | 1273 / 2026-09-17 | AX tree 上选动作+目标 | 作者帖「insanely fast」 |
| 0xNatoshi/jev-codex-router | 45 / 2026-09-17 | 判断任务难度再选模型 | 「237 turn…约 60%」作者回放 |
| y0usaf/pi-jev | （清单 126★） | noul/score 门：destructive 0.90、exfil 0.70、beyond_scope 0.85、impact 2.50 | 「roughly 300 ms」一次请求四问 |

其余 100+ 仓多数 0–2★、同日脚手架，0xLogicrw / yibie 均声明不背书。

---

## 3. 独立实测 / 批评

**准确率对照（有原始数字）：**

- **fazxes / Vercel fx**（2026-09-16，70×3=210）：Jev 98.6% vs gpt-5.6-luna 96.7%；见第 1 节原句。作者自测，非盲评。
- **lindfors.no**《An early-access test…》（2026-09-18）https://lindfors.no/blog/a-first-look-at-typesafes-jev/ ：24 份挪威语听证意见，`jev-1.13.0` vs DeepSeek V4.1 Flash。Stance 20/24 vs 20/24（reasoning off）vs 22/24（on）；Arguments 0.86 vs 0.89/0.88。原句：「Jev read all 24 documents for half a cent.」「Median latency 0.32 s」vs 2.7 s / 26 s。「The reference label says `for_with_changes`, so Jev got this one wrong. It also told me it was not sure」。「Careful wording made it worse」：argument 一致率 0.89→0.86，ECE 0.040→0.116。
- **Shogo-nfrealmusic/jev-eval** RESULTS.md（2026-09-18，60 条合成预约路由 ×3 轮，走 Vercel Gateway）：Category 精确匹配 Jev **96.1%** vs gpt-4o-mini 93.9%；vs Sonnet 4.5 为 95.5% vs 94.4%。p50 **379 ms** vs 1,209 / 1,910 ms。每千条 billed **$0.032** vs $0.122 / $3.41。「Jev is **3.2× faster** (p50) and **3.8× cheaper**. TypeSafe's published figures are "193.6× faster, 444.6× cheaper"」。「Under our conditions, the published multipliers were not reproduced」。失败原句：h07「what time tomorrow?」gold=`other`，Jev 三次都选 `reschedule`（0.60–0.65）。**1/380** Jev 调用 300s 超时。needs_human 漏报 21/69，弱于 4o-mini 的 16/69。
- **kuhung/understanding-jev**（中文深拆，非 yibie）：本机 Qwen2.5-0.5B「直接提取末位 Logits 的耗时则可以压制在 30 毫秒以内」vs 自回归 JSON「一两秒」。这是开源同类机制复现，**不是**对官方 Jev 权重的准确率对照。
- **ytal.io** 生产名寄回放（2026-09-17）：「这次组んだ设计では、Jevを本番の名寄せにそのまま採用するのは見送り」。confidence 0.85 时 228/350 保留。

**延迟：** 社区实测中位多在 **300–380 ms**（fazxes 312、lindfors 0.32s、jev-eval 379、ultrafast 单次 Jev 178 ms）。「70–500 ms」是厂商口径，被第三方转述而非独立全量复现。openchamber 汇总 333 个用户数字 median 76 ms、下四分位 2 ms——作者自己说「These are not enough to establish agreement」。

**价格体感：** lindfors「half a cent / 24 docs」→ 约 **$0.22 / 千份文档**。jev-eval **$0.032 / 千条消息**，并核「765 input tokens × $0.042 per million = $0.0000321」，与 Gateway 账单一致。gregpr07 航班任务 **$0.0039**。yibie 转述他人成本实验（724 条广告 9 分钱、3M 回放 $2.17）**未独立复现**。

**waitlist：** @0xLogicrw「昨天申请，今天就能用上。」@vista8「提交后没多久就通过了。」@Saccc_c「趁现在还通过的很快」。未见系统排队时长统计。

**rate limit：** typesafe-mcp 明确处理 **429 / 529**。jev-eval 在 Vercel 免费档会 429。官方 RPM 数字见第 5 节「未独立核实」。

**失败 / 降温：**

- @jiayuan_jy https://x.com/jiayuan_jy/status/2100876273061102006（2026-09-18）：「研究了一天 Jev，带来的新鲜感迅速回落，这好像就是一个更快的通用分类器/决策器，LLM 完全可以做到。……世界知识可能不一定有常规 LLM 那么全……复杂场景的决策结果是不是真的准还是要打一个问号」。「tool using 部分的选择还是不能用 Jev 来代替，因为这不是一个有限集」
- @vista8 / @bookingX0：「零幻觉」= 零结构错误，不是语义正确。
- pearpages.com（2026-09-16）：「"0% type errors, can't hallucinate" … Shape only」
- @zack80349105：不是多模态，游戏 demo 也要先翻成语言。
- RINNECODER/jev-behavior-study：洗车「walk vs drive」在加前提后仍可能选错；「Correct prerequisite answers do not always produce correct decisions」。

---

## 4. 与同类的对比

**GPT-5.6 luna：** 有。fazxes 安全分类器，见上：Jev 略准、中位快 4.7×、p95 快 17.6×。厂商 workflow 表被 ntorres.dev / pearpages 转述：luna 66.8% / $0.0033 / 12.9s vs Jev 67.8% / $0.0004 / 0.4s——**这是 TypeSafe 自建评测，不是第三方**。

**小模型分类器 / logprob：** 有机制复现，无与官方 Jev 的大规模准确率 PK。@anderslie https://x.com/anderslie/status/2100388704644919662（2026-09-17）：「It's not about how the model is trained - it's the inference technique. … you can modify an inference engine to provide a performant Jev-like API with any open-weight LLM. … Look at the logits … constrained to the valid choice labels」。kuhung / harshatheg/Qwen-2.5-1B-RLCD / jaredpalmer/kev / NanoJev / rorshopping/jev-on-a-laptop（本机 7B 主字段 96% vs Jev 发布表 67.8%——任务不同，不能直接比）。

**Outlines / guided decoding：** **未查到**严肃对照实验。仅见 Grok 回复（2026-09-16）随口：「Closest options include … or Outlines for constrained generation」。

**结论（社区共识，非官方）：** 在封闭选项的分类/审核上，Jev ≈ 中小 LLM 的准确率、低一个数量级的时延与成本；官方「193.6× / 444.6×」在 jev-eval 对 4o-mini/Sonnet 上复现不出来（3–5× 速度、3.8–106× 成本，取决于对照组）。不能替代带参数的 tool use 和生成。

---

## 5. 定价与可用性

以下价格多次被独立使用者账单验证，但仍源于厂商价目，不是社区另测出的影子价。

- **API：** lindfors / jev-eval / 多家评测一致转述并核账：**输入 $0.042 / 百万 token（$42 / 十亿），输出免费**。jev-eval：「Output tokens (119 on average) were not billed」。
- **并发 / RPM：** 社区代码只证明存在 429/529。iadecider.com 写「250,000 tokens per second; 1,200 requests per minute」——**未在本次检索中找到非官网一手来源，标未核实**。
- **区域：** 未查到区域封锁的社区实测。可用通道：直连 `api.typesafe.ai`、Vercel AI Gateway、Cloudflare Workers AI、OpenRouter beta（@OpenRouter 2026-09-18：「Jev tagged the messages in 2.3 seconds for a tenth of a cent. A chat LLM on the same batch took 20 seconds.»）。
- **自托管官方 Jev：** **没有**。权重未开源。社区有 Kev/NanoJev/openjev/simple-jev 等本地仿接口。
- **是否开源：** Jev 模型否；生态仓库 MIT 居多。
- **模型大小：** **未公布**。@iwashi86 据约 1 万次 API 推测 MoE + 因果 Transformer、「约3万トークンの入力をわずか160ミリ秒」；@johnrobinsn 猜「Terra-class」。均属推测。

Early access：waitlist + `console.typesafe.ai` 发 key。OpenRouter 可绕过 waitlist 跑示例（yibie 收录 typesafe-jev-examples）。

---

## 置信度低 / 有争议（没法核实的传言）

1. 官方首页 **193.6× 更快、444.6× 更便宜**：厂商四工作流自测；jev-eval 明确「published multipliers were not reproduced」。
2. **「不能幻觉」**：结构/类型零错误已被多方降温；语义对错仍会错（lindfors 4/24 stance 不一致、jev-eval h07）。
3. **95.9% 准确率超过 GPT-5 三个点**（@Bk1man 追问）：未见生产流量对照。
4. **模型参数量 / MoE / Terra-class**：逆向推测，无权重。
5. **@iwashi86「输出 token 数只是事后按字符串长度算的计费指标」**：单篇日文技术笔记，未交叉验证。
6. **yibie 转述的 9 分钱拆广告、$2.17 清 3M 事件**：二手，无原始实验页。
7. **9 Hz 游戏、每 300ms 链上下单、PostgreSQL `WHERE jev(...)`**：作者 demo，无第三方复现。
8. **vista8 飞书全文、yibie《三种提问原语与分层阈值》、theo 反驳长文逐句**：本次未打开。
9. **1200 RPM / 25 万 token/s**：只见于转述站，未核。
10. **awesome 清单后半 100+ 条**：大量 1★ 同日仓，雷达摘要套话，不可当用法证据。
