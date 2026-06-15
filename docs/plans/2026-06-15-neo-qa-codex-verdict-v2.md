**总判**

只读复验完成，没改文件。v2 收敛到位，没有发现新的事实错误；T4 有一个实现硬条件要盯住：承载 required check 的 workflow 本身也必须每个 PR 都跑。

**1. v1 六条事实错误纠正**

| 项 | 判定 | 理由 |
|---|---|---|
| `MessageAttachment.path` | PASS | v2 已把风险从 `ChannelAttachment.localPath` 修正到真实落库边界。源码确认 `localPath` 会映射成 `path`，`metadata` 也会带入：[channelAgentBridge.ts](/Users/linchen/Downloads/ai/code-agent/src/main/channels/channelAgentBridge.ts:722)，持久化 sanitizer 保留 `path/metadata`：[messageAttachments.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/utils/messageAttachments.ts:57)。 |
| `composer.focus` 误伤 | PASS | v2 已从 scope 级改成 action 级。`composer.focus` 和 `composer.slashMenu` 同属 composer scope：[actions.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/keybindings/actions.ts:78)，直接给 scope 加 focus guard 会伤到聚焦输入框能力。 |
| manual + vision runtime fallback | PASS | v2 已撤回“全链路静默送文本模型”的断言。runtime 确实有 capability detection、vision preflight、adaptive fallback：[inference.ts](/Users/linchen/Downloads/ai/code-agent/src/main/agent/runtime/contextAssembly/inference.ts:1166)，[inference.ts](/Users/linchen/Downloads/ai/code-agent/src/main/agent/runtime/contextAssembly/inference.ts:1203)。 |
| adaptive 信号源 | PASS | v2 已承认 `adaptive === true` 缺少“用户刚手选 vs 默认 base config”的来源信号。`ModelConfig` 当前只有 `adaptive`，没有 origin/source 字段：[model.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/model.ts:85)。 |
| `ModelDecision` 无 diagnostics | PASS | v2 已改成 typed 字段建议。contract 当前没有通用 `diagnostics` 字段：[modelDecision.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/modelDecision.ts:227)。 |
| workflow-level path filter | PASS | v2 已改成 job 内部 filter + required check 总产出。当前两个 gate 都在 workflow trigger 上用 paths：[capability-evidence.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/capability-evidence.yml:9)，[eval-harness-gate.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/eval-harness-gate.yml:14)。 |

**2. `⚠️待核` 是否合理**

| 待核点 | 判定 | 理由 |
|---|---|---|
| T1 `MessageAttachment.path` 赋值处 + metadata 落库点 | PASS | 实现前查代码合理，因为修点要落在 channel-origin 的真实边界，不能直接动全局 attachment persistence。当前我已抽核到锚点，但 v2 把它当 implementation preflight 没问题。 |
| T2 composer scope action 分类 | PASS | 合理。当前 composer scope 至少有 `send/newline/focus/slashMenu/files.attach`，其中 `slashMenu` 才是裸字符冲突主点；分类必须按 action 行为做，不能拍脑袋按 scope 做。 |
| T3 runtime fallback 行为 | PASS | 合理。源码有 preflight 成功、preflight 失败后 strip image、adaptive 整轮 fallback 等分支，实际行为和配置、候选视觉模型可用性有关。 |
| T3 adaptive 信号源 | PASS | 合理。当前 contract 看不到能区分“刚手选”和“默认配置”的字段，先找或补信号源是前置条件。 |
| T4 job 结构 | PASS | 合理，但实现时要明确：如果 gate 并入 `swarm-ci`，`swarm-ci` 自己当前也有 `pull_request.paths`：[swarm-ci.yml](/Users/linchen/Downloads/ai/code-agent/.github/workflows/swarm-ci.yml:14)。承载 required check 的 workflow 不能继续被 workflow-level paths 挡住。 |

**3. T3 重做方案**

PASS。三态划分成立：`auto + image` 保持 vision profile，`manual + 有视觉能力` 不干预，`manual + 无视觉能力 + image` 才需要推荐或提示。typed `recommendation` 字段也成立，因为 contract 里没有通用 diagnostics。把 adaptive 显式优先级放到“先找信号源，找不到就暂缓 C”也成立，避免把 auto 设计打乱。

**4. T4 CI 硬门**

PASS，方向能解决 v1 漏洞。核心条件是 required check 必须每个 PR 都产出状态：需要跑就跑，不需要跑也显式 pass，不能是 skipped 或缺席。实现时别只移动 `capability-evidence.yml/eval-harness-gate.yml` 的 paths；如果最终 check 挂在 `swarm-ci` 名下，`swarm-ci` 的 PR workflow trigger 也要保证每个 PR 进来。

一句话：v2 可以进入实现阶段，T5 直接做，T1/T2/T4 核完即做，T3 先调研 runtime fallback 和 adaptive 信号源，C 没有信号就暂缓。


