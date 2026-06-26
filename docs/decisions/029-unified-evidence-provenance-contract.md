# ADR-029：统一 Evidence / Provenance 契约

日期：2026-06-26

状态：Accepted（林晨 2026-06-26 拍板）

关联：`docs/plans/neo-tools/2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`（统领排期）、ADR-028（web-search 结构化输出 / provenance）、ADR-022~024（事件账本）

## 背景

`docs/plans/neo-tools/` 下 8 份工具长期方案中，有 7 份各自发明了一套"证据 / 账本 / proof"结构来回答同一个问题：**这条结论 / 这次完成，凭什么证据、证据新鲜吗、跑没跑、脱敏了没。**

| 文档 | 各自发明的结构 |
|------|------|
| task-splitting | `evidenceRefs`（挂 SessionTask） |
| codebase-navigation | `context fidelity ledger`（candidate/read/stale） |
| verification-loop | `VerificationEvidence` |
| browser/computer | `BrowserComputerProofBundle` |
| edit/patch/checkpoint | 变更账本（changedFiles/diffId/checkpointId） |
| primitive-tool | Read `evidenceToken` |
| tool-platform | `durable subagent ledger` |

七套并行 = 七套持久化 schema、七套脱敏规则、七处 UI 卡片、七份导出逻辑。这会重蹈 web-search 那条线的 provenance 裂缝，且让"完成证据"在不同 surface 互不相认，反而更难让非程序员用户信任 Neo 的"完成"。

Neo 是 cowork 协作产品、用户看不懂代码、只能信"完成证据"——证据契约的统一性直接关系产品信任，不是工程洁癖。

## 决策

立一个唯一的证据底座 `EvidenceRef`，置于 `src/shared/contract/evidence.ts`。**所有工具线的 evidence / ledger / proof 必须消费它，禁止再自立证据形状**；各域只在其上叠加领域字段。

### 契约定义

```ts
// src/shared/contract/evidence.ts —— 唯一证据底座
export type EvidenceKind =
  // 文件类
  | 'read' | 'file' | 'diff' | 'patch'
  // 验证类
  | 'tool' | 'test' | 'typecheck' | 'build' | 'ci'
  // 浏览器 / 视觉类
  | 'browser_dom' | 'browser_a11y' | 'screenshot'
  // 桌面 / 产物 / 轨迹类
  | 'computer_ax' | 'artifact' | 'trace';

export type EvidenceState =
  | 'fresh'         // 刚采集、可信
  | 'candidate'     // 搜索/索引产出的候选，未经 Read 绑定，不可进结论
  | 'read'          // 经 Read 绑定到精确范围的事实证据
  | 'stale'         // digest/mtime 不再匹配，需重采
  | 'needs_re_read' // 压缩后被标记必须重读
  | 'not_run';      // 验证未执行

export type RedactionStatus = 'clean' | 'redacted' | 'contains_secret_blocked';

export interface EvidenceRef {
  id: string;        // 稳定 id，供 trajectory / UI / 导出 / reviewer 引用
  kind: EvidenceKind;
  ref: string;       // 真实落点：path#L区间 / archive id / trace id / screenshot path / ci log url
  source: string;    // 产出动作：Read / Grep / VerificationRunner / browserAction / ComputerSurface ...
  freshness: {
    capturedAtMs: number;
    digest?: string; // sha256 短前缀，判 stale 用（大文件按页/小文件全量，详见 WP-B）
    state: EvidenceState;
  };
  redactionStatus: RedactionStatus;
}
```

### 各域如何叠加（不另立底座）

| 域 | 用法 |
|----|------|
| codebase-navigation | candidate/read/stale 直接是 `freshness.state`；"候选不进结论" = 结论只接受 `state === 'read'` 的 ref |
| primitive-tool | Read 的 evidenceToken = 一条 `kind:'read'` + `digest` 的 EvidenceRef；Edit/Write 前置条件 = 目标路径存在 `state:'read'` 且 digest 匹配的 ref |
| verification-loop | `VerificationEvidence = { status, failureType, ... } & { evidenceRefs: EvidenceRef[] }` |
| browser/computer | proof = `EvidenceRef[]`（dom/a11y/screenshot/ax）+ 领域字段（targetRef/approval/manualTakeover） |
| edit/patch | diff、patch 各一条 EvidenceRef；`checkpointId` 进领域字段 |
| task-splitting | `SessionTask.evidenceRefs: EvidenceRef[]` |
| tool-platform | durable ledger 持久化 EvidenceRef + agent 元数据，不另发明证据形状 |

### 不变量

1. **结论闸**：任何进入最终回答 / 计划 / 编辑前置的事实，对应 ref 必须 `state === 'read'`（或验证类的 `passed`）。`candidate` 不得直接进结论。
2. **脱敏闸**：`redactionStatus === 'contains_secret_blocked'` 的 ref 不得进入持久化、导出、模型上下文。
3. **新鲜闸**：消费 ref 前比对 `digest`/`capturedAtMs`，不匹配则降级为 `stale`，触发重采。
4. **单一来源**：禁止新增第二个证据基类；新域接入证据能力 = 扩展 `EvidenceRef`，不是复制它。

## 影响

- 新增 `src/shared/contract/evidence.ts`（WP-A，先于一切功能线落地）。
- WP-B/C/D/E 在各自接入点消费 `EvidenceRef`，删除/改写各自原计划的私有证据结构。
- 持久化与导出层（tool-platform durable ledger、session export、trajectory）以 `EvidenceRef` 为存储单元。

## 备选方案（未采纳）

- **七套各自实现，后期再统一**：返工成本七倍，且过渡期"完成证据"互不相认，否决。
- **复用 ADR-022 事件账本作为证据底座**：事件账本是时序 append-only spine，证据是"可被引用、可判新鲜、可脱敏"的事实单元，语义不同；证据可被事件引用（`kind:'trace'`），但不应混为一层。

## 验证

- `src/shared/contract/evidence.ts` 通过 `npm run typecheck`。
- 单测覆盖：EvidenceRef 工厂/守卫、结论闸（candidate 被拒）、脱敏闸（blocked 不导出）、新鲜闸（digest 不匹配降 stale）。
</content>
