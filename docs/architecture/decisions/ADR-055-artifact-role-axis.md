# ADR-055：产物角色轴——「什么是产物」从反推改成登记制

- 状态：accepted
- 日期：2026-08-07
- 取代：以 `READ_ONLY_ARTIFACT_TOOL_NAMES`（14 个工具名的拒绝清单）+ `NON_DELIVERABLE_TOOL_ARTIFACT_KINDS` 为主判据的反推式产物识别
- 关联：`code-agent-private-archive/docs/designs/2026-08-07-产物定义与过滤现状.html`（现状核实与竞品对照，含拍板记录）
- 同期先例：投影层 system 事件登记制（#1015，`shared/contract/systemEventRegistry.ts`）；记忆路径权威覆盖所有非 read 工具（#1016）

## 背景

Neo 是产物主轴的 cowork 产品（对标 Manus），「什么算产物」是核心语义。但这个判定此前是**反推式**的：
把工具调用的副作用（写了文件、返回了 URL）全当候选产物，再用规则往外剔。

这条路线必然漏，核实到三处正在发生的泄漏：

- `memoryWrite` 走 `createFileArtifact` 产出带 path 的产物，而 `memory_write` **不在**拒绝清单里（清单只有 `memory_read`）⇒ 写记忆被当交付物摆给用户。
- `youtubeTranscript` 的 url 是**源视频**（来源）、`mcpUnified` 的 url 是**读来的资源**（来源），却和 jira 新建 issue（真产物）走同一条 url 分支。

更要害的是**口径不一致**：同一个 `web_fetch` 抓的网页，聊天流（`artifactOwnership.ts`）判它 `link` 并降级进折叠的「来源」区（代码注释明确写了「它是过程性引用，不是模型产物」），概览（`workspacePreview.ts`）却转成 `web_snapshot` 直接摆进产物列表。同一份东西，两个界面给用户两个答案——不是两个决策打架，是**同一个决策漏了一处实现**。

**根因**：`kind`（text/image/document/web/process-output…）是**媒体类型轴**，被当成产物判据在用。缺的是一条正交的**角色轴**。拒绝清单是反推路线必然长出来的东西——既然什么都可能被扫进来，就只能一条条往外挡；而按名字枚举的清单，新增工具默认穿透。

对照成熟产品：Manus（交付文件 vs 电脑面板）、Claude Artifacts（模型显式调用工具创建）、ChatGPT Canvas（显式模式切换）、Devin（PR 唯一形态）、Cursor（diff 即产物）——**没有一个是反推派**。要么产物被声明，要么形态天然唯一。

## 决策

1. **加一条与媒体类型正交的角色轴**，共三档：
   - `deliverable` 交付物——用户会带走的东西，只有这类进产物列表；
   - `material` 过程材料——来源、检索结果、读取内容、命令输出，进「来源」区；
   - `receipt` 动作回执——发了邮件、建了日程、开了 issue，本期不上屏，只把语义标对。

2. **kind → role 的默认登记表是单一真源**（`shared/contract/artifactRoleRegistry.ts`），产出点可用 `role` 字段显式覆盖。沿用 #1015 的登记制范式，不另造风格。

3. **牙齿在编译期**：`ARTIFACT_KIND_ROLE_REGISTRY satisfies Record<ToolArtifactKind, ArtifactRole>`。以后 `ToolArtifactKind` 加了新 kind 而没在登记表补 role ⇒ tsc 报红（实测 `TS2741: Property '"fake-new-kind"' is missing ... but required in type 'Record<ToolArtifactKind, ArtifactRole>'`），不是静默漏。`TurnArtifactOwnershipItem.role` 同理设为**必填**——可选会让「新增分支忘了填」静默漏进产物，正是本轴要消灭的失效形态（改必填时 tsc 当场抓出一个漏填的产出点）。

4. **消费端唯一判据**：`isDeliverableArtifact()`，聊天流与概览两条通路都调它，不许各判各的。web 口径不一致由此自动消失，不单独打补丁。

5. **`text` 与 `binary` 分开对待**（一处早期判断被回归红线纠正）：
   - `text` 默认 `material`（fail-closed）——它确实含混，`read` 读出来的内容和 `Write` 写出的 .md 都是 text，判不了就不进产物，确属交付物的产出点显式覆盖；
   - `binary` 默认 `deliverable`——**不含混**。过程材料是文本形态的（日志、命令输出、检索结果），而二进制落盘物（zip 导出包、下载物）是用户会带走的东西，**不存在「读出来的二进制产物」这种形态**。
   初版规格把 `binary` 与 `text` 一并划入 material（动机是「含混的都 fail-closed」），被红线抓到：`site.zip` 从产物列表消失。教训是判据应当是**「用户会不会带走它」**，不是「保不保守」。

6. **拒绝清单收窄，不整份删**。核实：`read`/`listDirectory`/`readClipboard`/`memoryRead`/`glob` 都产 ToolArtifact（kind 为 text/search ⇒ material），所以对 **ToolArtifact 通道**清单已冗余。但 `artifactOwnership.ts` 还有一条**独立的 metadata 路径通道**（扫 `outputPath` 与 metadata 里的 `filePath`/`imagePath`/`videoPath`），它不经过 ToolArtifact，读取类工具会在 metadata 留下路径。故改为：**产了 ToolArtifact 的调用一律以角色轴为准，完全没产 artifact 的才走 metadata 兜底扫描**，清单只在那条兜底通道上继续承重。作用面从「所有工具」收窄到「不产 artifact 的老工具」，新工具只要产 artifact 就自动正确。

7. **过程材料有去处，不是被丢弃**（产品负责人 2026-08-07 拍板）：聊天流沿用已有的折叠「来源」区，从只装抓取链接扩到装全部 material；概览侧对称新增「过程材料」折叠区。这对齐 Manus「过程有自己的家」的形态——判错的代价是「要多点一下」，不是「东西没了」。

8. **`receipt` 本期不做 UI**。这类产物目前基本无 path/url，本来就不上屏；只把语义标对，为以后留位置。

## 后果

**得到**：产物判定从「消费方猜」变成「产出方声明」；新增 kind 漏登记是编译错误而非静默泄漏；两条通路口径统一；三处已知泄漏关闭。

**代价**：`text` 的 fail-closed 意味着**漏标 = 文件从产物里静默消失**（用户丢东西），比漏进产物更难被发现。这是本 ADR 引入的主要新风险，靠两道互补的门兜：

- `tests/renderer/utils/artifactRole.redlines.test.ts`——两组回归红线（必须仍在 / 必须不在），两条通路各断言一遍；
- `tests/unit/artifacts/deliverableRoleAnnotations.contract.test.ts`——读源码文本的静态契约门，逐个产出点断言 `role: 'deliverable'` **赋值行**存在。

两道缺一不可：红线用例手写 role 进夹具，测的是消费端分流，**测不到产出点有没有真设值**（实测：只有红线时撤掉 notebookEdit 的标注照样全绿）。静态门断言必须锚赋值行而非 `toContain`，否则产出点上方的解释性注释会把门喂饱。

**明确不做**：不给 82 个产出点全加标注（绝大多数 kind 已能唯一决定角色）；不引入 LLM 参与判定（产出方是代码，零 API 成本零延迟，确定性）；不做 Manus 式独立「工作台」面板（远超本次范围）。

## 未解决

- `kind: 'text'` 仍是最大的含混轴（41 处产出点）。本期只标注了带 path/url 且确属交付物的那几处，其余靠 fail-closed 默认。若将来某个 text 产出点变成交付物而漏标，静态门也不会知道——**它只守已登记在清单里的产出点**。真正的解法是让 `text` 这个 kind 本身消失（拆成更有语义的 kind），本期不做。
- `receipt` 目前零产出点、零消费。它是为语义完整留的位置，也可能永远用不上；若下次回看仍是零产出点，应当删掉而不是继续留着。
- metadata 兜底通道仍由按名字枚举的清单承重。它的作用面已收窄到「不产 artifact 的老工具」，但那批工具新增时依然会默认穿透。彻底解法是要求所有工具都产 ToolArtifact，本期不做。
