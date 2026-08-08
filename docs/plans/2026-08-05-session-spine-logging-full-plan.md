# Neo Session Spine · 日志能力完整方案（技术施工细稿）

> 日期：2026-08-05  
> 状态：设计稿 v1.4  
> **给劳拉的整合调研结论（推荐先读）：**  
> `code-agent-private-archive/docs/competitive/2026-08-05-日志能力对照与Neo-Session-Spine方案.md`  
> 对照：Claude / Codex / WorkBuddy / Qoder / Grok Build / Pi + Neo as-built + 官方文档  
> 相关：ADR-022、ADR-023、Telemetry 可诊断性、`diagnosticBundleService`、`sessionLedger`、`auditLogger`  
> 本文定位：文件锚点、契约、分阶段工单与测试矩阵；**调研叙事与全员对照以 competitive 整合稿为准**

---

## 0. 一句话

**SQLite 继续当权威写路径；对外补一条可搬运、可校验、ID 贯穿的 Session Spine——让「人 / 支持 / 外部 agent / 未来导入生态」都能像读 Claude jsonl 一样读懂一条 Neo 会话，同时保留 Neo 已领先的 fleet 观测、DecisionTrace、Replay、脱敏上传。**

这不是「加一个导出按钮」的最小补丁，而是把日志从**多 sink 副产物**升级为**产品一等公民数据面**。

---

## 1. 问题定义

### 1.1 现状（as-built，有锚点）

| 层 | 现状 | 锚点 |
|----|------|------|
| 会话权威 | SQLite `sessions` / `messages` / FTS / rewind | `schema.ts`, `SessionRepository` |
| 一本账投影 | 读侧合并 message/task/swarm/decision/execution | `sessionLedger.ts`, `sessionLedgerProjection.ts`, `getSessionLedger()` |
| 权限账本 | `permission_decisions` append-only + `DecisionTrace` | ADR-022, `decisionHistory.ts` |
| 工具执行账本 | `tool_execution_events` begin/complete | ADR-022 二期 |
| Telemetry | sessions/turns/model/tool/events/raw/bundles | `telemetryStorage.ts`, contract |
| 诊断包 | turn 树 + env 指纹 + raw；可脱敏 | `buildDiagnosticBundle` / `sanitizeDiagnosticBundle` |
| 会话日志导出 | **单 JSON 文件**：脱敏 bundle + **当天 app log 尾部 512KB** | `buildSessionLogExport` → 侧栏「导出会话日志」 |
| Markdown 导出 | 人读会话 | `exportMarkdown.ts` + 侧栏 |
| 审计 JSONL | `~/.code-agent/audit/YYYY-MM-DD.jsonl` + 表 `audit_log` | `auditLogger.ts` |
| 工程日志 | `logs/code-agent-YYYY-MM-DD.log`，7 天滚动，**无 lane** | `logger.ts` |
| 旁路 | `traces/*.jsonl`、`completion-summaries.jsonl`、`context-event-ledger.json` | 非主脊 |
| Fleet | Sentry / PostHog / Langfuse / admin-console | `docs/architecture/observability.md` |
| 导入 | Claude / Codex jsonl 可扫可预览 | `agentEngineHistoryImport.ts` |

### 1.2 真缺口（相对三家 + dogfood 痛点）

1. **真相分裂**：messages / session_events / telemetry / audit / app log / traces 多套存储，没有统一「会话包」目录形态。  
2. **可搬运性弱**：Claude/Codex/WB 是「一会话一文件」；Neo 导出是单 JSON 扁文件，且 **telemetry 关闭/历史会话时 bundle=null，只剩 log 尾部**。  
3. **transcript 不进诊断包**：`buildDiagnosticBundle` 从 telemetry 表拼 turn 树，**不读 `messages` 权威 transcript**——支持侧无法用导出包当完整对话回放。  
4. **ID 未强制贯穿**：`sessionId` 有；`turnId` / `traceId` / `toolCallId` / `runId` 在部分旁路（如 voice）只到日志层。  
5. **审计无完整性证明**：WB 有 `prevHash`/`hash`/`sequence`；Neo 纯 append JSONL。  
6. **工程日志大杂烩**：MCP / sandbox / browser / computer-use 无分仓，排障靠全文搜。  
7. **用户面时间线弱**：有 Replay / TurnQuality / Workbench，但缺「一本账」面向用户的统一时间线与失败 turn 一键摘要。  
8. **体积与保留**：单库可到 GB 级 + raw payloads；清理策略偏工程默认，产品设置不足。  
9. **无开放镜像**：外部 agent 无法 `cat ~/.code-agent/sessions/...jsonl` 接力。

### 1.3 成功标准（可度量）

| 指标 | 目标 |
|------|------|
| 支持复现 | 用户只发一个 `.neo-session` 包（或 zip），无本机 DB 即可还原：对话顺序、工具链、权限决策、失败 stack 切片、版本指纹 |
| 外部可读 | 包内 `transcript.jsonl` 可被 grep / 被 Neo 自己 re-import 预览 |
| 对账 | 任意 app log 行（含 sessionId）可反查到 transcript tool 行 + telemetry turn（有则链上，无则显式 `missing`） |
| 审计 | 日 segment 哈希链可 `neo audit verify` 通过；篡改尾部可检测 |
| 隐私 | 默认导出包已脱敏；「含原文 raw」需二次确认 + 本地路径标记 `privacyLevel` |
| 性能 | 镜像 append p99 < 5ms 不阻塞主路径；导出 1000 消息会话 < 15s |
| 体积 | 设置页可见 telemetry 占用；一键清 30 天 raw 后占用下降可验证 |

---

## 2. 设计原则

1. **单一权威写路径**：会话消息只写 SQLite；镜像与导出是投影，禁止双写两套互相矛盾的「真相」。  
2. **投影可重建**：任何 jsonl 镜像 / 导出包必须能从权威源 **全量重放生成**（`rebuildMirror(sessionId)`），避免镜像腐烂后无法自愈。  
3. **相关 ID 契约优先于新 UI**：没有 ID 贯穿，时间线/包都是装饰。  
4. **默认隐私安全**：出站与「发给别人」路径默认 scrub；本地全文 raw 仅本地。  
5. **不降维抄 CLI**：不废弃 telemetry / Langfuse / DecisionTrace / Replay 去「只剩 jsonl」。  
6. **Lane 扩展，不造第二本总账物理表**：延续 ADR-023——总账是读侧投影；文件包是投影的落地形态。  
7. **Fail-open 对写入、fail-closed 对隐私**：镜像/哈希失败不拦 agent 主循环；脱敏失败则拒绝导出外传副本。

### 2.1 非目标

- 不做企业 OTLP collector 对接为 P0（Langfuse 已够用；OTLP 可进远期）。  
- 不做 Codex Record & Replay / CUA 录技能（品类不同）。  
- 不把 Claude 的 `~/.claude` 目录结构原样硬抄进用户家目录根（Neo 仍归属 `~/.code-agent`）。  
- 不在本方案重做 memory / dream / distill（只消费 ledger 作为输入源）。  
- 不改变权限策略语义，只增强可观测与可校验。

---

## 3. 目标架构

### 3.1 逻辑分层

```
                    ┌─────────────────────────────────────┐
                    │  Product Surface                      │
                    │  Timeline · Export · Retention · CLI  │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │  Session Spine Service (新)           │
                    │  package · mirror · verify · rebuild  │
                    └─────────────────┬───────────────────┘
                                      │ 只读投影 / 受控写镜像
          ┌───────────────┬───────────┼───────────┬──────────────┐
          ▼               ▼           ▼           ▼              ▼
   SQLite 权威      Audit 链     App Log Lanes  Telemetry     Decision/
   messages/…       hash chain   分文件 JSONL    turns/raw     execution 账本
          ▲               ▲           ▲           ▲              ▲
          └───────────────┴───────────┴───────────┴──────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │  Correlation Context (AsyncLocal)     │
                    │  sessionId·turnId·traceId·runId·…     │
                    └─────────────────────────────────────┘
```

### 3.2 磁盘目标布局

```text
~/.code-agent/
  code-agent.db                    # 权威（不变角色）
  sessions/                        # 🆕 开放镜像根（可关）
    <project-slug>/
      <sessionId>.jsonl            # transcript 镜像（append + 可 rebuild）
      <sessionId>.meta.json        # 轻量索引：title/updated/messageCount/hash
  packages/                        # 🆕 导出包缓存（可选，TTL）
    neo-session-<id>-<ts>/
  audit/
    2026-08-05.jsonl               # 升级：带 sequence/prevHash/hash
    state.json                     # 🆕 当前 segment 链状态
  logs/
    app/code-agent-YYYY-MM-DD.log  # 兼容迁移自扁平 logs/
    mcp/…
    sandbox/…
    browser/…
    computer-use/…
    sync/…
    crash/…
  traces/                          # 保留测试旁路或逐步收口进 spine
```

### 3.3 导出包契约（`.neo-session` 目录或 zip）

```text
neo-session-<sessionId-short>-<YYYYMMDD-HHMMSS>/
  manifest.json              # 包元数据 + privacyLevel + 内容清单 + 校验
  README.txt                 # 人读：如何打开、含什么、隐私说明
  transcript.jsonl           # 🆕 权威 messages 投影（必有，即使无 telemetry）
  ledger.json                # SessionLedger 完整投影
  timeline.jsonl             # 归一化事件流（见 §4.3）——人与 UI 主消费
  audit.jsonl                # 本 session 审计切片（含链字段）
  decisions.jsonl            # permission_decisions + DecisionTrace
  executions.jsonl           # tool_execution_events 切片
  telemetry/
    summary.json             # session + turn 聚合（无全文 raw）
    bundle.sanitized.json    # 现有 DiagnosticBundle 脱敏版（有则）
    raw/                     # 仅 privacyLevel=full_local 时存在
  logs/
    app.tail.log             # 时间窗对齐，非「当天随意 512KB」
    <lane>.tail.log          # 各 lane 切片
  versions.json              # agent/prompt/toolSchema/app/git
  environment.json           # env 指纹
  integrity.json             # 各文件 sha256 + 可选 audit 链 verify 结果
```

**兼容**：现有侧栏「导出会话日志」升级为默认导出 **zip 包**；保留「导出单文件 JSON（legacy v1）」开关一版，避免老脚本瞬间断裂。

---

## 4. 核心契约

### 4.1 Correlation Identity（强制）

```ts
// src/shared/contract/correlation.ts  (新)
export interface CorrelationIds {
  sessionId: string;
  /** 当前用户可见轮次；无 turn 上下文时 null */
  turnId: string | null;
  /** 跨进程/MCP/swarm 传播；W3C traceparent 的 trace-id 兼容 hex */
  traceId: string;
  /** workflow / goal / swarm run；无则 null */
  runId: string | null;
  /** 工具调用；无则 null */
  toolCallId: string | null;
  /** work item / voice handoff 等；可选扩展 */
  workItemId?: string | null;
  /** 父 turn（子 agent / meta） */
  parentTurnId?: string | null;
  /** 来源 surface：chat | workflow | voice | channel | cli | eval */
  surface?: string;
}
```

**实现要求：**

| 点 | 做法 |
|----|------|
| 传播 | `AsyncLocalStorage<CorrelationIds>`：`src/host/observability/correlationContext.ts` |
| 入口 | `conversationRuntime` turn 开始时 `runWithCorrelation`；spawn/swarm/voice/channel 继承或 fork `parentTurnId` |
| Logger | `createLogger` 每行自动 merge correlation 字段（无则省略，禁止假 id） |
| Audit | `AuditEntry` 扩展 `turnId?` `traceId?` `toolCallId?` |
| Telemetry | 已有 turn/tool id；补 `traceId` 列或 metadata 强制写入 |
| MCP | 已有 W3C traceparent：与 `traceId` 对齐，禁止再生一套 |
| 验收 | 集成测试：一次 bash 工具调用 → app log 行、audit 行、telemetry_tool_calls、messages tool 段 **四者 id 可 join** |

### 4.2 Transcript 镜像事件（`transcript.jsonl`）

设计目标：对 Claude 族 **可读**，对 Neo **可 re-import**，但不承诺 100% Claude 字节兼容。

```ts
// 每行一个 JSON object
type TranscriptLine =
  | {
      v: 1;
      type: 'session_meta';
      ts: number;
      sessionId: string;
      projectPath?: string;
      title?: string;
      model?: string;
      agentVersion?: string;
    }
  | {
      v: 1;
      type: 'message';
      ts: number;
      sessionId: string;
      messageId: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      turnId?: string | null;
      traceId?: string;
      visibility?: 'active' | 'rewound' | 'meta';
      content: unknown; // 已脱敏策略见 §7
      parentMessageId?: string;
    }
  | {
      v: 1;
      type: 'tool_call';
      ts: number;
      sessionId: string;
      turnId: string;
      toolCallId: string;
      name: string;
      arguments: unknown;
      status: 'started' | 'completed' | 'failed' | 'cancelled';
      durationMs?: number;
      resultSummary?: string;
      error?: string;
    }
  | {
      v: 1;
      type: 'permission';
      ts: number;
      sessionId: string;
      toolCallId?: string;
      outcome: string;
      reason: string;
      decisionId?: string;
    }
  | {
      v: 1;
      type: 'compact_marker';
      ts: number;
      sessionId: string;
      kind: string;
      summary?: string;
    }
  | {
      v: 1;
      type: 'run_link';
      ts: number;
      sessionId: string;
      runId: string;
      kind: 'workflow' | 'swarm' | 'goal' | 'spawn';
      status: string;
    };
```

**写入策略：**

- 默认 **async append**（`fs.appendFile` 队列，有序、单 writer per session）。  
- message commit / tool end / permission final 为触发点。  
- `visibility=rewound` 仍写入（审计需要），meta 可选配置。  
- 损坏或版本升级：`sessionSpine.rebuildMirror(sessionId)` 从 DB 全量重写。

### 4.3 Timeline 统一事件（`timeline.jsonl`）

在 SessionLedger 五泳道上扩展，供 UI 与包消费：

```ts
type TimelineLane =
  | 'message' | 'task' | 'swarm' | 'decision' | 'execution'
  | 'telemetry' | 'audit' | 'system' | 'voice' | 'channel';

interface TimelineEvent {
  v: 1;
  at: number;
  lane: TimelineLane;
  kind: string;
  summary: string;
  sessionId: string;
  turnId?: string | null;
  traceId?: string;
  runId?: string | null;
  toolCallId?: string | null;
  refId?: string;
  detail?: Record<string, unknown>;
  /** 严重度：info | warn | error — UI 过滤 */
  severity?: 'info' | 'warn' | 'error';
}
```

`buildSessionTimeline(sessionId)` = 扩展后的 `buildSessionLedger` + telemetry turn 边界 + audit 切片 + 可选 voice/channel 事件。

### 4.4 Manifest

```ts
interface SessionPackageManifest {
  packageVersion: 2;
  format: 'neo-session';
  builtAt: number;
  sessionId: string;
  privacyLevel: 'shareable' | 'local_rich' | 'full_local';
  /** 内容有无 */
  includes: {
    transcript: boolean;
    ledger: boolean;
    timeline: boolean;
    audit: boolean;
    decisions: boolean;
    executions: boolean;
    telemetrySummary: boolean;
    telemetryBundle: boolean;
    telemetryRaw: boolean;
    logTails: string[]; // lane names
  };
  versions: {
    appVersion: string;
    agentVersion?: string;
    promptVersion?: string;
    toolSchemaVersion?: string;
  };
  timeRange: { startAt: number | null; endAt: number | null };
  stats: {
    messageCount: number;
    toolCallCount: number;
    decisionCount: number;
    errorCount: number;
    estimatedCost?: number;
  };
  source: {
    hadTelemetrySession: boolean;
    mirrorPresent: boolean;
    rebuiltFromAuthority: boolean;
  };
  files: Array<{ path: string; sha256: string; bytes: number }>;
}
```

### 4.5 隐私级别

| Level | 用途 | 内容 |
|-------|------|------|
| `shareable`（默认导出） | 发给支持/社区 | transcript 脱敏、ledger、timeline、audit 摘要、telemetry summary、脱敏 bundle（无 thinking/raw 全文）、log 切片脱敏 |
| `local_rich` | 本机复盘 | + 更长 tool output、decision trace 全文、未截断 ledger detail |
| `full_local` | 开发者本机 | + telemetry raw payloads；**禁止**默认上传/一键分享；UI 强警告 |

现有 `sanitizeDiagnosticBundle` / `scrubString` / `sensitiveDataGuard` / surface redaction **全部复用**，不允许导出路径绕过。

---

## 5. 子系统完整设计

### 5.1 SessionSpineService（新中枢）

**路径建议：** `src/host/session/spine/`

| 模块 | 职责 |
|------|------|
| `sessionSpineService.ts` | 对外 API：exportPackage / rebuildMirror / appendMirror / verifyIntegrity |
| `transcriptMirrorWriter.ts` | 有序 append 队列 + 背压 |
| `transcriptProjector.ts` | messages → TranscriptLine[] |
| `timelineBuilder.ts` | 扩展 ledger 投影 |
| `packageBuilder.ts` | 组装目录/zip、写 manifest/integrity |
| `packageSanitizer.ts` | privacyLevel 过滤 |
| `logWindowExtractor.ts` | 按 session 时间窗 + correlation 从 lane 日志抽 tail |
| `mirrorPaths.ts` | project-slug 规则（对齐 Claude path encoding，可复用 import 侧逻辑） |
| `cliSessionSpine.ts` | CLI 入口 |

**API（host + IPC + CLI 同构）：**

```ts
interface SessionSpineAPI {
  exportPackage(sessionId: string, opts: {
    privacyLevel: PrivacyLevel;
    format: 'directory' | 'zip';
    includeRaw?: boolean; // 仅 full_local
    outputDir?: string;
  }): Promise<{ path: string; manifest: SessionPackageManifest }>;

  rebuildMirror(sessionId: string): Promise<{ path: string; lineCount: number }>;
  rebuildAllMirrors(filter?: { since?: number; projectPath?: string }): Promise<RebuildReport>;

  getTimeline(sessionId: string): Promise<TimelineEvent[]>;
  getTranscriptLines(sessionId: string, opts?: { includeRewound?: boolean }): Promise<TranscriptLine[]>;

  verifyAuditChain(date?: string): Promise<AuditVerifyResult>;
  verifyPackage(packagePath: string): Promise<PackageVerifyResult>;

  /** 失败 turn 一键摘要（已脱敏） */
  buildFailureDigest(sessionId: string, turnId?: string): Promise<FailureDigest>;
}
```

**与现有函数关系：**

| 现有 | 关系 |
|------|------|
| `buildSessionLogExport` | 变为 `exportPackage` 的 **legacy 适配层**（v1 单 JSON），内部调 packageBuilder 再 flatten，或标记 deprecated |
| `buildDiagnosticBundle` | 成为 package 的 `telemetry/bundle.sanitized.json` 组件；**不再是唯一诊断真相** |
| `getSessionLedger` | timeline 主数据源之一；timeline 超集 |
| `exportSessionToMarkdown` | 保留；可选 `package/transcript.md` 附加生成 |
| `exportSessionFork` | 端口性导出仍独立；manifest 可 `related: fork` 互链 |

### 5.2 诊断包升级（v2）

`DiagnosticBundle.bundleVersion: 2`：

- 增加 `transcript: TranscriptLine[]` 或外置文件引用  
- 增加 `ledger: SessionLedger`  
- 增加 `correlationSample`：本 session 采样的 id 完整性报告  
- `logTail` 改为 `logWindows: Record<lane, string>` + **按 session start/end ± 缓冲**截取，而不是「当天文件最后 512KB」  
- session 无 telemetry 时：**仍必须**有 transcript + ledger + logs（修当前最大产品洞）

### 5.3 审计哈希链（WorkBuddy 级）

**改造 `auditLogger.ts`：**

```ts
interface AuditEntryV2 extends AuditEntry {
  schemaVersion: 2;
  id: string;              // uuid
  sequence: number;        // 全局单调 per segment
  prevHash: string;        // 上一条 hash；创世为 64 个 0
  hash: string;            // sha256(canonical(entry without hash))
  turnId?: string | null;
  traceId?: string | null;
  toolCallId?: string | null;
}
```

`audit/state.json`：

```json
{
  "schemaVersion": 1,
  "currentSegment": "2026-08-05.jsonl",
  "sequence": 1204,
  "lastHash": "…",
  "closedSegments": ["2026-08-03.jsonl", "2026-08-04.jsonl"]
}
```

- 跨日：关闭 segment，写 `closedSegments`，新日 sequence 可重置或全局延续（建议 **全局延续**，防跨日重放攻击叙事更干净）。  
- 查询 API 保留；增加 `verifySegment(date)` / `verifyAll()`。  
- DB 表 `audit_log`：可选同步 `sequence/hash` 列，或文件为权威、DB 为索引——**推荐文件链为完整性权威，DB 继续服务查询**（双写时 hash 只在文件路径计算一次）。  
- 与 `permission_decisions.trace_json`：决策行写入 audit `eventType=permission_check` 时带 `decisionId` 互指。

### 5.4 工程日志分 Lane

**改造 `logger.ts`：**

```ts
createLogger(scope: string, opts?: { lane?: LogLane });

type LogLane =
  | 'app' | 'mcp' | 'sandbox' | 'browser'
  | 'computer-use' | 'sync' | 'crash' | 'voice' | 'channel';
```

- 默认 lane=`app`；MCP client/server → `mcp`；sandbox exec → `sandbox`；等。  
- 文件：`logs/<lane>/code-agent-YYYY-MM-DD.log`（或 `<lane>-YYYY-MM-DD.log`）。  
- 行格式强制 JSON：`{ts, level, scope, lane, msg, sessionId?, turnId?, traceId?, …fields}`。  
- 迁移：旧 `logs/code-agent-*.log` 继续读；新写入走 lane 目录；`getCurrentLogFilePath()` 扩展为 `getLogFilePath(lane)`。  
- 保留策略：按 lane 可配；默认 app 14 天，其它 7 天，crash 30 天。  
- `logWindowExtractor`：给定 `[start,end]` + `sessionId`，扫相关 lane，过滤 correlation 匹配行（无 id 的行在时间窗内以 `scope` 启发纳入，标记 `confidence: weak`）。

### 5.5 产品 UI 完整面

#### A. 会话时间线（主聊天 / 侧栏详情）

- 新组件 `SessionTimelinePanel`（Workbench 或会话详情 Drawer）。  
- 数据：`getTimeline(sessionId)`。  
- 交互：按 lane 过滤、只看 error、点击跳转 TurnCard / 工具详情 / DecisionTrace。  
- 与现有 `TurnQualityStrip` / `ReplayAuditPanel` **并列**，不替换：Timeline 是导航，Replay 是证据深潜。

#### B. 导出体验

| 入口 | 行为 |
|------|------|
| 侧栏右键「导出会话日志」 | 默认 `shareable` zip → Downloads；toast 显示路径 |
| 侧栏右键「导出完整本地包…」 | 对话框选 privacyLevel；`full_local` 二次确认 |
| 导出弹窗 `ExportModal` | 增加「Session Package」tab：预览 includes 勾选 |
| 设置 → 系统诊断 | 「导出最近失败会话包」「打开 logs 目录」「打开 sessions 镜像目录」 |
| 失败 toast / run_failed | 「导出此失败诊断」快捷按钮 → `buildFailureDigest` + shareable 包 |

#### C. 设置 → 隐私 / 数据

- 镜像开关：`sessionMirror.enabled`（默认 dogfood 开 / 发行可默认开，体积可控）  
- 镜像保留：天数 / 最大 GB  
- Telemetry raw 保留：与现有封顶策略产品化  
- 「清理…」向导：预览将删体积 → 确认  
- Audit 链：只读状态 +「校验完整性」按钮  
- 诊断包默认 privacyLevel

#### D. CLI

```bash
neo session export <id> [--privacy shareable|local_rich|full_local] [--zip] [--out dir]
neo session timeline <id>
neo session rebuild-mirror [<id>|--all]
neo audit verify [--date YYYY-MM-DD]
neo logs open [--lane mcp]
neo package verify <path>
```

（命令名对齐现有 CLI 品牌；实现落在 `src/cli/`。）

### 5.6 Failure Digest（支持友好）

```ts
interface FailureDigest {
  sessionId: string;
  turnId?: string;
  title: string;
  happenedAt: number;
  errorSummary: string;
  lastUserPromptScrubbed: string;
  lastTools: Array<{ name: string; success: boolean; error?: string }>;
  permissionDenies: number;
  versions: Manifest['versions'];
  suggestedNextSteps: string[]; // 规则生成，非 LLM 必须
  packageReadyHint: string;
}
```

规则源：telemetry turn error、audit 失败、session_events error、app log error 行。  
可选：本地小模型润色建议（默认关，避免导出路径依赖模型）。

### 5.7 体积与保留治理（完整）

| 数据 | 默认保留 | 清理动作 |
|------|----------|----------|
| app/mcp/… logs | 7–30 天按 lane | 已有 cleanOldLogs 扩展 |
| audit jsonl | 90 天 | 归档 `audit/archive/` 或删除（删除破坏跨段 verify，需写 tombstone） |
| session mirror | 60 天或 5GB LRU | 删 jsonl+meta，可 rebuild |
| telemetry raw | 现有三重封顶 + UI | 清 raw 留 summary |
| diagnostic bundles 表 | 30 天 | 删 queued 已上传 |
| export package cache | 7 天 | 删 `packages/` |
| SQLite messages | 用户会话生命周期 | 不自动删；归档会话可「冷存储」远期 |

设置页展示：`TelemetryHealth` 已有 → 扩展 `StorageHealth`（db 体积、logs、audit、mirror、raw）。

### 5.8 导入 / 互通

- **Outbound**：`transcript.jsonl` 足够稳定后，提供「导出为 Claude-compatible preview」可选转换器（有损：丢 Neo 独有 decision lane）。  
- **Inbound**：已有 Claude/Codex import；镜像格式文档化后允许「从 neo-session 包恢复预览会话」（只读 fork），不直接写回生产 session 除非用户确认。

### 5.9 Swarm / Workflow / Voice / Channel

| Surface | Spine 要求 |
|---------|------------|
| Swarm | `runId` 贯穿；timeline `lane=swarm`；子 agent transcript 可嵌套文件 `agents/<agentId>.jsonl` 进包 |
| Workflow | stage 事件进 timeline；package includes `workflow-run.json` |
| Voice | telemetry 维度补齐（已有日志三元组缺口）；lane=`voice` |
| Channel（飞书等） | 入站/出站事件 lane=`channel`；脱敏强制（通知只短摘要的现有策略保持） |

包结构扩展（完整方案必须预留）：

```text
agents/
  <agentId>.jsonl
  <agentId>.meta.json
workflow/
  run.json
  stages.jsonl
```

---

## 6. 分阶段交付（完整路线，不是砍 scope）

> 每阶段都可单独合入 main 且有验收；**总体范围 = 全方案**。阶段是施工顺序，不是「只做 P0」。

### Phase 0 · 契约与相关 ID（地基）

**工期参考：1 周**

- [ ] 新增 `correlation.ts` + `correlationContext.ts`  
- [ ] logger 自动注入 correlation  
- [ ] conversationRuntime / toolExecutor / spawn / voice 入口接线  
- [ ] 集成测试：四 sink join  
- [ ] 文档：`docs/architecture/session-spine.md` 骨架  

**门禁：** 无 ID 贯穿，禁止开 Phase 2 UI 宣称「完整轨迹」。

### Phase 1 · 权威 transcript 进导出（修最大洞）

**工期参考：1–1.5 周**

- [ ] `transcriptProjector` 从 messages 投影  
- [ ] `packageBuilder` v2 目录/zip  
- [ ] `buildSessionLogExport` → 调 v2（默认 shareable zip；legacy JSON 可选）  
- [ ] **无 telemetry 也能导出完整对话 + ledger + log 窗**  
- [ ] log 窗按 session 时间范围，而非「当天尾 512KB」  
- [ ] 单测 + 侧栏导出 dogfood  

### Phase 2 · Timeline + Failure Digest + UI

**工期参考：1.5–2 周**

- [ ] `timelineBuilder` 扩展 ledger  
- [ ] `SessionTimelinePanel`  
- [ ] Failure Digest + 失败路径 CTA  
- [ ] ExportModal / 设置入口对齐  
- [ ] i18n 中英  

### Phase 3 · Session Mirror（开放文件系统）

**工期参考：1–1.5 周**

- [ ] mirror writer 队列  
- [ ] message/tool/permission 钩子  
- [ ] rebuild / rebuild-all  
- [ ] 设置开关与保留  
- [ ] CLI `rebuild-mirror`  
- [ ] 性能压测：长会话 5k 消息  

### Phase 4 · Audit 哈希链

**工期参考：1 周**

- [ ] AuditEntryV2 + state.json  
- [ ] 迁移：旧行无 hash 时 verify 报告 `legacyUnchained`  
- [ ] `neo audit verify`  
- [ ] 导出包带 audit 切片 + integrity  
- [ ] 与 permission_decisions 互指  

### Phase 5 · 工程日志分 Lane

**工期参考：1–1.5 周**

- [ ] logger lane 目录  
- [ ] 关键调用点标注 lane（MCP/sandbox/browser/CUA/sync/voice）  
- [ ] logWindowExtractor 多 lane  
- [ ] 旧路径兼容读  
- [ ] 设置「打开 logs」按 lane  

### Phase 6 · 保留治理 + StorageHealth

**工期参考：1 周**

- [ ] StorageHealth IPC  
- [ ] 清理向导  
- [ ] raw/mirror/packages TTL  
- [ ] 文档与隐私文案  

### Phase 7 · 多 surface 收口 + 互通

**工期参考：1.5–2 周**

- [ ] swarm agents 子 transcript 入包  
- [ ] workflow run 入包  
- [ ] voice/channel lane 事件  
- [ ] Claude-compatible 有损导出（可选）  
- [ ] neo-session 包只读导入预览  

### Phase 8 · 硬化与运营

**工期参考：1 周**

- [ ] package verify 签名可选（本地 hmac with machine key，防盘上静默改）  
- [ ] admin-console 支持上传 shareable 包元数据（非 raw）索引  
- [ ] 性能与体积回归基线写入 CI  
- [ ] 架构文档收口 + CHANGELOG + 用户帮助文案  

**合计参考：约 10–12 周单线程；2 人并行可压到 6–8 周。**

---

## 7. 隐私与安全完整策略

1. **本地权威允许原文**（用户机器上的 DB/raw）。  
2. **任何「分享 / 上传 / 剪贴板诊断」走 shareable 消毒**。  
3. 消毒层顺序：surface redaction → logMasker/secretRedaction → scrubString 路径 →（可选）PII；禁止在 raw 上无上限跑重模型 PII（已有 110s 教训）。  
4. `full_local` 包路径必须含 `LOCAL-ONLY` 目录名或 manifest 标记；UI 禁用「复制到聊天分享」。  
5. 镜像默认写脱敏后的 tool output 摘要还是原文？  
   - **决议：镜像写与 DB 同级原文（本地），导出再消毒。** 与「权威一致」原则对齐。  
6. 审计链哈希对 **消毒后字段** 还是原文？  
   - **决议：对落盘 audit 文件的实际字节哈希**（已 mask 的 input/output），与 WB 一致可验证。  
7. Incognito / 隐私模式：若产品有「不留痕」会话，镜像与 raw 必须 fail-closed 不写（对齐 maka 竞品纪律）。

---

## 8. 数据流（关键路径）

### 8.1 正常一轮对话

```
user message
  → persist messages (SQLite)
  → correlation.run(turn)
  → mirror.append(message)
  → model + tools
      → audit.log(tool) [hash chain]
      → permission_decisions / tool_execution_events
      → telemetry onTool*
      → logger(lane) with correlation
      → mirror.append(tool_call/permission)
  → assistant message persist
  → mirror.append(message)
  → turn end telemetry
```

### 8.2 用户导出

```
UI exportPackage(shareable)
  → transcriptProjector(messages)
  → getSessionLedger + timelineBuilder
  → audit slice by sessionId
  → decisions/executions slice
  → buildDiagnosticBundle? (nullable OK)
  → logWindowExtractor(timeRange, sessionId)
  → packageSanitizer
  → zip + integrity
  → Downloads
```

### 8.3 镜像自愈

```
启动后 idle 或用户触发 rebuild
  → 读 messages/tools/decisions
  → 原子写 temp → rename
  → 更新 meta.json (content hash)
```

---

## 9. 文件级改造清单

### 9.1 新增

| 路径 | 说明 |
|------|------|
| `src/shared/contract/correlation.ts` | ID 契约 |
| `src/shared/contract/sessionSpine.ts` | TranscriptLine / Manifest / Timeline / Package |
| `src/host/observability/correlationContext.ts` | ALS 传播 |
| `src/host/session/spine/**` | 中枢实现 |
| `src/renderer/components/features/session/SessionTimelinePanel.tsx` | 时间线 UI |
| `src/renderer/components/features/session/ExportSessionPackageDialog.tsx` | 隐私级别导出 |
| `src/renderer/components/features/settings/StorageHealthPanel.tsx` | 体积与清理 |
| `src/cli/sessionSpine.ts` | CLI |
| `docs/architecture/session-spine.md` | 架构正文 |
| `tests/unit/session/spine/**` | 单测 |
| `tests/integration/session/spine-correlation.test.ts` | 四 sink join |
| `tests/integration/session/spine-export-no-telemetry.test.ts` | 无 telemetry 仍完整 |

### 9.2 大改

| 路径 | 改动 |
|------|------|
| `src/host/telemetry/diagnosticBundleService.ts` | v2 包组件；log 窗；legacy 适配 |
| `src/host/security/auditLogger.ts` | 哈希链 + correlation 字段 |
| `src/host/services/infra/logger.ts` | lane 目录 + JSON 行 + correlation |
| `src/host/services/core/sessionLedgerProjection.ts` | timeline 扩展或旁路调用 |
| `src/host/app/agentAppService.ts` | 新 IPC API |
| `src/shared/contract/appService.ts` | 类型 |
| `src/renderer/.../sessionContextMenuItems.ts` | 导出 zip |
| `src/renderer/components/features/export/ExportModal.tsx` | Package tab |
| `src/renderer/i18n/*` | 文案 |
| `src/host/agent/runtime/conversationRuntime.ts` | correlation 入口 |
| `src/host/tools/toolExecutor.ts` | toolCallId 注入 audit/log |
| schema/migrations | audit 可选列；telemetry trace_id 若落列 |

### 9.3 文档

| 路径 | 说明 |
|------|------|
| `docs/ARCHITECTURE.md` | 增 Session Spine 一节 |
| `docs/architecture/observability.md` | 与 fleet 边界 |
| `docs/architecture/data-storage.md` | 镜像与保留 |
| `docs/api-reference/security.md` | AuditEntryV2 |
| 本计划 | 施工 SSOT |

---

## 10. 测试与验收矩阵

| ID | 场景 | 期望 |
|----|------|------|
| T1 | 正常会话导出 shareable | zip 含 transcript+ledger+timeline+manifest；无密钥/家目录明文 |
| T2 | telemetry 关闭历史会话导出 | transcript 仍完整；bundle 可 null；manifest.source.hadTelemetrySession=false |
| T3 | 权限拒绝一轮 | decisions + audit + timeline decision lane 可见 |
| T4 | 工具失败 | Failure Digest 非空；tools 列表含 error |
| T5 | 相关 ID | 同一次 Bash：log/audit/telemetry/message 可 join |
| T6 | 镜像 append 后 kill -9 | rebuild 后与 DB 一致 |
| T7 | 篡改 audit 中间行 | verify 失败 |
| T8 | full_local 含 raw | manifest.privacyLevel 正确；UI 有警告 |
| T9 | 长会话 2k 消息导出 | < 15s；内存无爆 |
| T10 | lane 日志 | MCP 错误只出现在 mcp lane 文件 |
| T11 | 清理 raw | StorageHealth 体积下降；summary 仍在 |
| T12 | swarm 子 agent | 包内 agents/* 存在且 runId 关联 |
| T13 | 回归 | 现有 diagnosticBundle 单测全绿；legacy JSON 导出仍可用一版 |

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 镜像与 DB 不一致 | rebuild 权威；meta content hash；启动抽样校验 |
| 哈希链双写复杂 | 文件为链权威；DB 不强求 hash 列 |
| 导出过大 | shareable 截断 tool output；分卷 zip 远期；默认不带 raw |
| 性能 | mirror 异步队列；背压丢弃时打 metric（不可静默丢审计） |
| 隐私事故 | 导出强制 sanitize；单测红线密钥样例 |
| 范围膨胀 | 严格按 Phase 合入；Phase 7 可并行但不阻塞 1–4 |
| 用户不懂 zip | README.txt + 侧栏「显示在 Finder」 |

---

## 12. 与竞品的最终对照（做完后）

| 维度 | Claude | Codex | WorkBuddy | Neo（本方案完成后） |
|------|--------|-------|-----------|-------------------|
| 会话文件可读 | ✅ | ✅ | ✅ | ✅ mirror + 包 |
| 无 telemetry 仍有对话 | ✅ | ✅ | ✅ | ✅（修洞） |
| 审计哈希链 | ❌ | ❌ | ✅ | ✅ |
| 工程 lane 日志 | 散 | 散 | ✅ | ✅ |
| Fleet / LLM trace | 弱 | 弱 | 弱 | ✅ 保持领先 |
| 产品内时间线 | 弱 | 中 | 弱 | ✅ |
| 一键可分享诊断包 | 拷目录 | 拷 rollout | 拷多处 | ✅ 结构化 zip |
| 深度 Replay / DecisionTrace | 弱 | 中 | 弱 | ✅ 保持领先 |

---

## 13. 决议清单（开工前拍板）

| # | 问题 | 方案默认（可改） |
|---|------|------------------|
| R1 | 镜像默认开还是关？ | **默认开**，设置可关 |
| R2 | 镜像写原文还是摘要？ | **原文（同 DB）**，导出消毒 |
| R3 | 默认导出 zip 还是单 JSON？ | **zip v2**；legacy JSON 保留 1 个大版本 |
| R4 | audit sequence 跨日？ | **全局延续** |
| R5 | 无 telemetry 的历史会话？ | 导出仍成功，manifest 标明 |
| R6 | swarm 子 transcript 是否默认进包？ | **默认进 shareable（脱敏后）** |
| R7 | 是否做 Claude 有损导出？ | Phase 7 可选，不挡主线 |
| R8 | 包是否需要机器 hmac？ | Phase 8；非 P0 |

---

## 14. 建议立即开工顺序（执行视角）

1. **Phase 0 + Phase 1** 必须连做：没有 ID 与「transcript 进包」，后面 UI 全是空壳。  
2. Phase 2 UI 与 Phase 3 mirror 可两人并行。  
3. Phase 4 audit 链与 Phase 5 lane 日志可并行。  
4. Phase 6 依赖 3/5 的体积数据。  
5. Phase 7/8 收口多 surface 与运营。

---

## 15. 源索引

- 本机对照：`~/.claude/projects`、`~/.codex/sessions`、`~/.workbuddy/projects` + `audit-log`、`~/.code-agent/*`  
- Neo：`diagnosticBundleService.ts`、`sessionLedger.ts`、`auditLogger.ts`、`logger.ts`、`observability.md`、ADR-022/023  
- 侧栏导出：`sessionContextMenuItems.ts` → `exportDiagnostics`  
- 竞品审计链：WorkBuddy `audit-log/*.jsonl` 的 `prevHash`/`hash`/`sequence`

---

## 16. 结语

完整方案的本质不是「多记一点 log」，而是：

> **建立 Session Spine：权威在库、投影在文件、分享在包、校验在链、排障在 lane、复盘在时间线。**

做完后 Neo 在「深度可观测」上继续领先，在「可搬运 / 可校验 / 可被外部 agent 阅读」上追平并在「结构化诊断包」上反超 Claude/Codex/WorkBuddy。

---

## 17. 官方文档与行业实践补充（2026-08-05 修订）

> 来源：Claude Code 官方 Sessions / Monitoring 文档、Codex 官方 CLI/App-Server/Hooks/Non-interactive 文档、WorkBuddy/CodeBuddy FAQ 与 Changelog、业界 OTel/LLMOps 惯例，以及模型训练知识中的 agent 可观测共性。  
> 作用：在 §0–16 完整方案之上的**增量补强**，不推翻主架构。

### 17.1 结论：主方案方向成立，需补 9 块产品化能力

本机拆解已经抓住「可搬运主脊 / 审计链 / lane / 诊断包」；官方文档补上的是 **resume 语义、保留策略叙事、格式稳定性承诺、一键打包给支持、OTel 企业面、Hooks 旁路采集、跨 surface 会话统一、无痕/临时会话、全局 prompt 索引**——这些是用户与团队运维真正天天碰到的。

| # | 补充项 | 主要来自 | 并入阶段 |
|---|--------|----------|----------|
| S1 | **格式稳定性纪律**（internal vs stable export API） | Claude Code 官方 Sessions 明确：jsonl **entry format is internal and changes between versions**，脚本应走 `/export` 或 script interface | Phase 1 契约 |
| S2 | **保留策略产品化**（默认天数 + 可配 + 防误删叙事） | Claude `cleanupPeriodDays` 默认 30 天；社区强烈反应「别默默删我的历史」 | Phase 6（策略表 Phase 1 就写进 settings 契约） |
| S3 | **无痕 / 临时会话** | Claude `CLAUDE_CODE_SKIP_PROMPT_HISTORY`；Codex **ephemeral session**（non-interactive 可不落盘） | Phase 0/3 |
| S4 | **Resume 一等公民**（`--last` / 按 cwd 域 / fork / archive） | Codex `codex resume`、`resume --last`、app-server `thread/resume|unarchive`；Claude `--resume` / `/export` | Phase 2/7 |
| S5 | **人读导出与机器包双轨** | Claude `/export` → Markdown；Codex 自动 jsonl 但缺好用 md 导出（社区痛点） | Phase 1（md 已有，包内强制带 `transcript.md`） |
| S6 | **支持侧「一键打开日志包」** | WorkBuddy 官方 FAQ：**帮助 → 打开日志文件夹 → zip 包**；并明示隐私 | Phase 1/2 UI |
| S7 | **OTel 可选出口**（默认关，企业开） | Claude 官方 `CLAUDE_CODE_ENABLE_TELEMETRY` + OTLP metrics/logs/traces；团队监控缓存命中率/成本 | Phase 8 提前到「可选 Phase 6b」或 8 |
| S8 | **Hooks 旁路观测点** | Claude/Codex SessionStart/PreToolUse/PostToolUse/Stop；不改主循环即可外挂 SIEM | Phase 0 契约 + Phase 5 |
| S9 | **全局会话索引 + 跨项目搜索** | Claude `history.jsonl` 全局 prompt 索引；Codex `session_index.jsonl` + 按日分片；社区做 Agent Sessions 浏览器用 | Phase 3/6 |
| S10 | **时间分片与归档目录** | Codex `sessions/YYYY/MM/DD/` + `archived_sessions` + unarchive | Phase 3 mirror 布局可选对齐 |
| S11 | **Background/daemon 日志** | CodeBuddy/WorkBuddy `codebuddy logs`、`--bg` 日志到 logs 目录 | Phase 5/7 |
| S12 | **压缩/resume 事件进时间线** | Codex hooks：SessionStart source = `startup|resume|clear|compact` | Phase 2 timeline kinds |
| S13 | **脚本/Agent 可编程读取** | Claude 官方鼓励 script interfaces；社区 MCP `list_sessions/get_messages/export_session` | Phase 7：Spine MCP 或 CLI JSON |
| S14 | **配置目录可迁移** | Claude `CLAUDE_CONFIG_DIR` | 已有 `CODE_AGENT_*` 路径 → 文档化 + 镜像跟随 |

### 17.2 各产品官方要点 → Neo 映射

#### Claude Code（code.claude.com/docs sessions + monitoring）

| 官方要点 | 对 Neo 的补充 |
|----------|----------------|
| Transcript 默认 `~/.claude/projects/<munged-cwd>/<session>.jsonl` | 镜像路径规则已规划；**munged path 算法与 Claude 对齐可提升互操作**（import/export 生态） |
| **格式不保证稳定**，应用 `/export` 或 script API | Spine 必须分两层：`transcript.jsonl` = **稳定 v1 契约**（semver）；内部 DB schema 可自由变。禁止文档写「兼容 Claude 原始行格式」除非提供独立 converter |
| `cleanupPeriodDays` 默认 30 | 设置页显式「会话镜像保留 N 天」；默认不要暗删用户无感知的数据；清理前 **StorageHealth 预览**（方案已有，升为必做文案） |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | 隐私会话 / 无痕：`session.persistTranscript=false` 时镜像、raw、history 索引 fail-closed 不写 |
| `/export` 人读 Markdown | 包内 **强制** `transcript.md`（不只 jsonl）；侧栏保留「仅导出 Markdown」 |
| OTel opt-in：metrics（tokens/cost/sessions/loc/commits）+ logs（API/tool/permission） | 方案原「❌ OTLP 不做 P0」**部分修正**：C 端默认仍关；**企业/自托管提供 OTLP exporter 可选模块**，复用 correlation + scrub。与 Langfuse 并存：Langfuse=LLM 轨迹，OTel=团队用量与 SIEM |
| Hooks 生命周期 | Spine 事件应可被现有 HookManager 订阅（SessionStart/End、PostToolUse 写旁路 log） |

#### Codex（developers.openai.com codex CLI / app-server / hooks / non-interactive）

| 官方要点 | 对 Neo 的补充 |
|----------|----------------|
| Rollout jsonl = resume 的**执行真相**（不只展示） | 包与镜像的设计目标从「给人看」升为 **可 resume 的投影**（至少 fork-readonly；完整 resume 绑定 runtime state 另线） |
| `codex resume` / `resume --last` / cwd-scoped | CLI/UI：**恢复最近会话**、**按项目过滤**；列表不靠用户翻 UUID |
| `sessions/YYYY/MM/DD/` 分片 + archive/unarchive | mirror 布局可选 `sessions/active/` + `sessions/archive/YYYY/MM/`，避免单目录数万文件（本机 Claude projects 已证明会胀） |
| App-server `thread/resume` 与 CLI 共用 rollout | Desktop/CLI/channel **同一 session id 空间**（Neo 已有部分，Spine manifest 写 `surfaces: []`） |
| Ephemeral / 不落盘 non-interactive | eval、CI、`--ephemeral` 跑批：不写 mirror、不进 history 索引 |
| Hooks：`SessionStart` source 含 `resume|compact` | timeline 必记：`session_resumed`、`compact_applied`，否则复盘「为什么上下文变了」会瞎 |
| Goals 跨 turn 持久目标 | Goal/workflow 状态进 package `workflow/run.json`（Phase 7 已有，升为与 Goal 合同字段对齐） |
| 社区痛：缺好用 md 导出、会话难搜 | Neo 应用 **md + 全局 FTS（已有 messages FTS）+ 包** 三件套打穿 |

#### WorkBuddy / CodeBuddy（FAQ、Changelog、CLI 参考）

| 官方要点 | 对 Neo 的补充 |
|----------|----------------|
| **帮助 → 打开日志文件夹 → zip 包** 给支持 | 设置/Help 一级入口「导出诊断包 / 打开日志」；zip 是官方支持路径，不是高级隐藏功能 |
| 日志可能含对话与设备信息 → 链到隐私声明 | 导出 toast + README 强制隐私提示；`shareable` 默认消毒 |
| Changelog：安全中心审计日志搜索；transcript/replay 写入策略；分批写盘 | ① audit UI 要有**搜索**不只校验；② mirror **分批/让步写盘**（背压），防 Windows/大会话卡死——WB 已踩坑 |
| `codebuddy logs` / `--bg` daemon 日志 | background task / agent team 日志进 lane 或 `logs/workers/`；CLI `neo logs <task>` |
| 历史对话支持导出/删除 | 会话菜单：导出包、导出 md、删除（删会话时同步删 mirror + 索引） |

### 17.3 训练知识中的跨产品共性（方案原稿未充分写死）

1. **双轨：Execution log vs Presentation log**  
   - Execution（Codex rollout / 工具 IO / 权限）用于 resume 与审计。  
   - Presentation（md / timeline UI）用于人。  
   - 混成一个「大 JSON」会两头不讨好 → 包内分文件是对的，且 **禁止用 UI 状态当唯一日志**。

2. **Append-only + 投影重建**（event sourcing 轻量版）  
   - 行业共识：日志只追加；「当前视图」是投影。  
   - Neo 的 rewind/visibility 已是此模型；镜像 rebuild 与之一致。

3. **OpenTelemetry 语义约定（GenAI）**  
   - span：`gen_ai.chat` / tool span 父子；attributes：model、token、finish_reason、tool_name。  
   - 若做 OTel 出口，**attribute 名对齐 GenAI semconv**，避免自创一套无法进 Grafana/Honeycomb。

4. **LLMOps 评测闭环**  
   - Langfuse/Phoenix/Coze Loop：trace → dataset → eval。  
   - Neo 已有 eval/replay；补充：**从 shareable 包或 timeline 一键「加入评测集」**（sourceSessionId 硬绑），方案原文仅 fleet，缺「日志→评测」桥。

5. **成本与缓存可观测**  
   - Claude OTel 强调 cache read ratio / cost；团队管理靠这个。  
   - Neo StorageHealth 外补 **CostHealth**：按日/项目/模型（telemetry 已有 cost bucket 契约 ADR-023）——设置页可见，不只 admin。

6. **子 agent 树是 trace 树不是扁平列表**  
   - Laminar/LangSmith 对 Claude Agent SDK：subagent = child span。  
   - package `agents/*.jsonl` 必须带 `parentSessionId|parentTurnId|traceId`，timeline 可折叠树。

7. **安全：审计日志与对话日志分离权限**  
   - SIEM 实践：permission/command audit 可进企业日志管道；prompt 正文默认不进。  
   - `shareable` 包与 OTel 默认 **metrics + 工具名 + 结果摘要**，prompt 正文单独 `OTEL_LOG_USER_PROMPTS` 式开关。

8. **性能：无界日志拖垮 resume**  
   - Codex issue：本地 state/log 胀导致 startup/resume 变慢。  
   - 验收补：会话列表/resume 路径 **不得** 全量读 mirror；只读 meta 索引。

### 17.4 对原方案的具体修订清单

#### A. 契约层（§4）

- [ ] 增加 `TranscriptFormatVersion` semver；changelog 约束「破坏性变更必须升 major + converter」。  
- [ ] `session_meta` 增加：`resumeCount`、`forkedFrom`、`ephemeral`、`surfaces[]`。  
- [ ] Timeline kinds 固定枚举增加：`session_started|session_resumed|session_forked|compact_applied|session_archived|export_created`。  
- [ ] Manifest 增加 `retentionPolicyAtExport`（导出时的保留配置快照，便于支持复现环境）。

#### B. 产品行为（§5.5）

- [ ] **Help/菜单「打开日志 / 导出诊断 zip」** 对齐 WorkBuddy FAQ（非仅侧栏右键）。  
- [ ] **`/export` 或命令面板等价物**：当前会话一键 md + 可选 package。  
- [ ] **Resume UX**：最近会话、按项目、fork；CLI `session resume --last`。  
- [ ] **无痕会话**开关：跳过 mirror、history 索引、raw telemetry。  
- [ ] 删除会话：级联 mirror + packages 缓存 +（可选）audit 不删（审计保留）。

#### C. 保留与目录（§5.7 / §3.2）

- [ ] 默认保留策略写进设置默认值表（建议：mirror 90 天、app log 14、audit 180、raw 14）；**禁止静默无限胀也禁止无提示狂删**。  
- [ ] Mirror 目录防胀：`active/` + `archive/YYYY/MM/` 或按 project 分片（Codex 按日启发）。  
- [ ] 全局索引：`session-index.jsonl` 或 SQLite `session_spine_index`（id、project、title、updatedAt、path、messageCount）——列表 O(1)。

#### D. 可观测出口（原非目标修正）

- [ ] **可选 OTLP exporter**（默认 off）：metrics（tokens/cost/session/tool_error_rate）+ logs（permission/tool summary）；traces 与 Langfuse 二选一或双写需 ADR。  
- [ ] 管理员可配「团队默认开 OTel」（类 Claude administrator-managed settings），本地用户可 opt-out。  
- [ ] 明确：**不做**「替代 Langfuse」；OTel 服务 **团队用量与 SIEM**，Langfuse 服务 **LLM 调试轨迹**。

#### E. Hooks / 可编程面

- [ ] Spine 关键节点 emit 内部事件，供 HookManager 与未来 MCP `neo_session_*` tools。  
- [ ] CLI 全部 `--json` 可脚本化（对齐官方「script interfaces」哲学）。

#### F. 性能与写入策略（WorkBuddy Changelog 教训）

- [ ] Mirror 写入：**批量 coalesce**（如 50ms 窗）+ 分片让步，避免每 token/每 tool 同步 fsync。  
- [ ] 大 session 导出：流式写 zip，限制单文件内存。  
- [ ] Resume/列表路径只碰 index/meta。

#### G. 评测桥（LLMOps）

- [ ] Phase 7/8：`Add to eval dataset` from timeline selection or package（`sourceSessionId` + `sourceTurnId`）。

#### H. 阶段表微调（§6）

| 原 Phase | 增补 |
|----------|------|
| 0 | + ephemeral/no-history 标志；+ Hook 事件点位 |
| 1 | + 稳定格式版本；+ 包内 `transcript.md` 强制；+ Help 导出 zip；+ 格式兼容性测试 |
| 2 | + resume/fork UX；+ compact/resume timeline kinds；+ 全局会话搜索入口 |
| 3 | + archive 布局；+ session-index；+ 批量写盘；+ 删除级联 |
| 5 | + workers/bg lane；+ hooks 旁路 |
| 6 | + cleanupPeriod 产品文案；+ CostHealth；+ OTel 设置（可标 6b） |
| 7 | + Spine MCP/脚本 API；+ 评测集回流 |
| 8 | OTel 硬化、semconv、管理员策略 |

### 17.5 明确不改动的判断（官方有、我们仍不抄或后置）

| 项 | 理由 |
|----|------|
| 把权威改回「仅 jsonl」 | Claude 自己都说格式不稳；DB+稳定 export API 更优 |
| 默认打开 OTel 出站 | 隐私与 C 端成本；opt-in |
| 云端统一会话（Claude Desktop 服务端历史） | Neo 本地优先；fleet 已有脱敏上传通道 |
| 完整「录制 GUI 操作变 skill」 | 非日志域（Codex Record&Replay） |
| 100% 字节兼容 Claude/Codex 原始 jsonl | 官方都不承诺稳定；做 converter 而非假兼容 |

### 17.6 补充后的成功标准（增量）

| 指标 | 目标 |
|------|------|
| 支持路径 | 用户只需「帮助 → 导出诊断包」，支持拿到 zip 即可工作 |
| 格式 | 连续两个 major 内 `transcript.jsonl` v1 可读；破坏性变更有 converter |
| Resume | 从 UI/CLI 恢复最近会话 ≤ 2 次点击/一条命令；不扫全量 mirror |
| 无痕 | 开关打开后磁盘无新 mirror/raw/history 行（测试断言） |
| 团队 | OTel opt-in 后 Grafana 可见 sessions/tokens/cost（可选验收） |
| 防胀 | 默认保留策略启用 30 天后 mirror 体积有上限策略可验证 |

### 17.7 源索引（官方与二手）

- Claude Sessions: https://code.claude.com/docs/en/sessions （transcript 路径、cleanupPeriodDays、SKIP_PROMPT_HISTORY、格式 internal）  
- Claude Monitoring / OTel: `CLAUDE_CODE_ENABLE_TELEMETRY` + OTLP（SigNoz/Honeycomb/Bindplane 等集成文）  
- Codex CLI resume / non-interactive resume / ephemeral  
- Codex App Server thread/resume|unarchive；Hooks SessionStart sources  
- WorkBuddy FAQ 日志 zip；CodeBuddy CLI `logs` / `--bg`；Changelog 审计与 replay 写盘  
- 社区：Simon Willison 30 天清理警示；claude-code-log / Agent Sessions 浏览生态  


---

## 18. Grok Build 开源落盘 + 本机 Qoder 实现对照（2026-08-05）

> 证据：本机 `~/.grok/`（含官方 user-guide 17-sessions / 24-monitoring-usage）+ 本机 `~/.qoder/` / Qoder.app / QoderWork Application Support。  
> 说明：Grok Build 源码已开源（xai-org/grok-build）；此处以**本机运行时落盘 + 官方用户文档**为准（与开源设计一致）。

### 18.1 Grok Build：几乎就是「Session Spine 参考实现」

#### 存储哲学（官方文档原话级）

- **每个会话一个目录**，按 cwd URL-encode 分组：  
  `~/.grok/sessions/<encoded-cwd>/<session-id>/`
- **`updates.jsonl` 是 resume 权威**（ACP session update 流）  
- **`chat_history.jsonl`** = 真正发给模型的消息（execution/presentation 分轨）  
- **`summary.json`** = 列表索引（title、model、计数、git head、parent）  
- **`events.jsonl`** = 运行时观测（phase、tool start/complete、permission、MCP、turn）  
- **`signals.json`** = 聚合计数器（tokens、tool 失败、compact 次数…）  
- **`rewind_points.jsonl`** = 每 prompt 文件快照（/rewind）  
- **`prompt_history.jsonl`**（cwd 级）= 跨会话 prompt 索引  
- **`system_prompt.txt` / `prompt_context.json`** = 可复现提示指纹  
- subagents 进正常 sessions 树 + 父目录 `subagents/` 元数据  
- 列表搜索：`grok sessions list|search` + **本地 SQLite FTS** 索引  
- 工程日志：`~/.grok/logs/unified.jsonl`（结构化 `ts/src/lvl/msg/ctx`）  
- 沙箱：`sandbox-events.jsonl` 独立 lane  
- OTel：**双 opt-in**（`GROK_EXTERNAL_OTEL` + exporter）；**默认无内容**；与产品 telemetry 严格分离；`OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_TOOL_DETAILS` 内容门  

#### 对本方案的直接映射

| Grok 文件 | Neo Session Spine 对应 | 是否补进方案 |
|-----------|------------------------|--------------|
| `updates.jsonl`（resume 权威） | 镜像 `transcript.jsonl` **或** 独立 `updates.jsonl`；**resume 不能只靠 SQLite 无文件投影** | ✅ 升级：明确「resume 投影文件」角色 = updates |
| `chat_history.jsonl`（模型视图） | 压缩后 API 视图可落 `chat_history.jsonl`（可选，debug 用） | 🟡 Phase 3 可选；与 ProjectionEngine 对齐 |
| `summary.json` | `session.meta.json` + 全局 index | ✅ 已有，字段对齐 Grok（git head/branch/model） |
| `events.jsonl` | timeline / events lane | ✅ 已有；补 phase_changed 级细粒度 |
| `signals.json` | FailureDigest + CostHealth 输入 | ✅ Phase 2 |
| `rewind_points` | Neo 已有 rewind/visibility；文件级 snapshot 可对标 | 🟡 非日志主线，交叉引用 file-history |
| `system_prompt.txt` | diagnostic versions / prompt hash 旁路落盘 | ✅ 诊断包加 `prompt_fingerprint` |
| `grok sessions list/search` | CLI `neo session list/search` | ✅ Phase 2/3 |
| headless `-c`/`-r` + JSON 吐 sessionId | CLI 同构 | ✅ |
| OTel 双 opt-in + 默认无内容 | §17 S7 强化：抄 Grok 门控，而非 Claude 单开关 | ✅ |
| unified.jsonl 工程日志 | lane 日志；可另有 unified 聚合视图 | 🟡 |
| sandbox-events 独立 | computer-use / sandbox lane | ✅ Phase 5 |
| active_sessions.json（pid+cwd） | 运行中会话登记（崩溃恢复） | 🟡 Phase 7 |

#### Grok 比原稿更强、应吸收的 6 点

1. **多文件目录 = 包的「常驻形态」**，不是只在导出时组装 zip；zip 只是目录的打包。  
2. **Resume 权威与模型视图分离**（updates vs chat_history）——避免「UI 看到的」和「模型吃到的」混成一条 jsonl。  
3. **summary 带 git 指纹**（root/remote/head/branch）——诊断包 environment 应默认同级。  
4. **signals 聚合文件**——不用扫全量 events 才能回答「多少 tool 失败」。  
5. **sessions search = SQLite FTS + 可选 remote**——Neo 已有 messages FTS，应暴露 CLI/设置搜索，不靠 grep 镜像。  
6. **OTel 与产品 telemetry 防火墙**（Grok 明确两套开关、内容默认关、headers 不落盘）——比「可选 OTel」更可落地。

#### Grok 相对 Neo 仍弱 / 不必抄

- 无 WorkBuddy 级 **审计哈希链**  
- 无 Langfuse 级 LLM span 产品调试台（有 OTel/内部 telemetry）  
- 无 DecisionTrace 多层权限叙事（有 permission_requested/resolved 事件）  
- 会话目录可能很大（单 session updates 数 MB）——列表靠 summary，**禁止扫 updates**（验收已写，Grok 实践印证）

### 18.2 本机 Qoder：Claude 族 + IDE 分仓 + Meta 旁路

#### CLI / Agent 数据面（`~/.qoder`）

```
~/.qoder/projects/<munged-cwd>/
  <sessionId>.jsonl              # Claude 族 transcript（uuid/parentUuid/agentId/type）
  <sessionId>-session.json       # 旁路 meta：title、tokens、cost、message_count、parent_session_id、working_dir、quest
  <sessionId>/<fileHash>-v1.json # 编辑文件版本快照（path/content/version）
  <sessionId>/*-initial.json
~/.qoder/events/events_YYYY-MM-DD.jsonl
~/.qoder/logs/qodercli.log | qoder-agent-sdk-typescript.log
~/.qoder/shell-snapshots/
```

JSONL 字段与 Claude Code 高度同构：`uuid/parentUuid/sessionId/cwd/type/message/isSidechain/agentId`。  
**Meta 与 transcript 拆分**是相对纯 Claude 的增量：列表/用量不必解析整条 jsonl。

#### IDE / Work 数据面

- `~/Library/Application Support/Qoder/logs/<timestamp>/…`：VS Code 系 window/exthost 日志  
- `Qoder/User/workspaceStorage/*/chatEditingSessions/`：编辑会话  
- `QoderWork/logs/<timestamp>/main/{sdk,mcp,startup,app,cron,…}.log`：**按进程+子系统分文件**（与 WorkBuddy lane 同思路）  
- `SharedClientCache/repowiki/knowledge.db`：知识库旁路  

#### 实现思路归纳

| 思路 | 做法 | Neo 借鉴 |
|------|------|----------|
| Claude 兼容主脊 | project 下 jsonl | 镜像格式可「Claude 族可读」 |
| Meta 旁路 | `*-session.json` 轻量索引 | = Grok `summary.json` / 我们的 meta |
| 文件级审计 | session 目录下 v1 内容快照 | 对齐 rewind/file-history，进诊断包可选 |
| parent_session_id | meta 字段 | fork 树 |
| quest 标记 | meta.quest | workflow/goal surface 标记 |
| IDE 与 CLI 分仓 | App Support vs ~/.qoder | Desktop host log vs agent transcript 分目录 |
| Work 分 lane 日志 | main/sdk/mcp/… | Phase 5 lane |
| 无强哈希审计 | 未见 prevHash | 仍跟 WorkBuddy |

#### Qoder 相对 Grok/Neo 的短板

- 无多文件 execution/events/signals 拆分；长会话列表依赖 meta，但 **resume 细节仍靠单 jsonl**  
- 无官方级 OTel 双门控文档  
- CLI 表面偏简单（jobs/mcp/status），缺 `sessions search` / 结构化诊断包  
- IDE 日志与 agent transcript **用户难一次打包**（支持路径弱于 WorkBuddy zip FAQ）

### 18.3 三角对照（Grok / Qoder / Neo 目标态）

| 维度 | Grok Build | Qoder（本机） | Neo 目标（本方案） |
|------|------------|---------------|-------------------|
| 权威写路径 | 目录多文件 jsonl | Claude 族 jsonl + meta | **SQLite** + 目录投影 |
| Resume 文件 | `updates.jsonl` | session jsonl | 投影 transcript/updates |
| 索引 | summary + SQLite FTS | `*-session.json` | meta + 已有 FTS + CLI search |
| 运行时事件 | events.jsonl 细 | 弱 / events 日文件 | timeline + events |
| 模型视图 | chat_history 分轨 | 混在 jsonl message | 可选 chat_history 投影 |
| 聚合信号 | signals.json | meta tokens/cost | signals + CostHealth |
| 工程日志 | unified.jsonl | CLI log + IDE 分仓 | lane 分仓 |
| 沙箱/安全事件 | sandbox-events | 弱可见 | audit 链 + lane |
| OTel | 双 opt-in 无内容默认 | 未见对等 | 抄 Grok 门控 |
| 诊断包 | 目录即包 | 散 | zip = 目录打包 |
| 深度 LLM 调试 | 中 | 中 | Langfuse/telemetry 领先 |
| 权限可解释 | 事件级 | 弱 | DecisionTrace 领先 |

### 18.4 对方案的增量修订（在 §17 之上）

1. **磁盘常驻形态对齐 Grok 目录，而不是「仅导出 zip」**  
   ```
   ~/.code-agent/sessions/<encoded-cwd-or-project>/<sessionId>/
     summary.json          # = meta（含 git 指纹）
     transcript.jsonl      # 稳定对外契约（人/agent 可读）
     updates.jsonl         # 可选：更密 ACP 式更新（若 resume 需要）
     events.jsonl          # 运行时 phase/tool/permission
     signals.json          # 聚合
     decisions.jsonl       # 权限切片或符号链到 audit
     prompt_fingerprint.*  # hash 或截断 system prompt
   ```  
   导出 zip = **该目录 + audit 切片 + log 窗 + telemetry summary**。

2. **明确两层日志**（抄 Grok）：  
   - Presentation/resume：`transcript`/`updates`  
   - Model view：`chat_history`（仅 debug/full_local，默认可不镜像全文以省盘）

3. **CLI** 对齐 Grok：  
   `neo session list|search|export|resume --last`；headless 输出 `sessionId` JSON。

4. **OTel** 对齐 Grok 而非仅 Claude：  
   双开关 + 默认无 prompt/路径/命令 + 内容门 + 与 Langfuse/产品 telemetry 防火墙。

5. **Qoder meta 字段**并入 summary：`parent_session_id`、`cost`、`token` 汇总、`quest/goal` 标志。

6. **文件版本快照**（Qoder v1）与 Neo file-history/rewind **互链进诊断包**（`files/` 可选），不新建第二套。

7. **active_sessions** 登记（Grok）：崩溃后「谁在跑」可恢复/告警。

### 18.5 结论

- **Grok Build** 验证了完整方案的目录 Spine 方向，并给出可抄的细部：updates 权威、chat_history 分轨、signals、sessions FTS CLI、OTel 双门控、summary 含 git。  
- **Qoder** 验证了 Claude 族镜像 + **轻量 meta 旁路** + IDE 分 lane 日志 + 文件快照；适合作为「互操作格式」与「meta 字段清单」来源。  
- **Neo 差异化保持**：SQLite 权威查询/FTS/fork、DecisionTrace、Langfuse、诊断脱敏上传、审计哈希链（跟 WorkBuddy）——用 Grok 的目录形态把「可搬运」补齐，而不是把权威改成纯文件。

> 一句话：**用 Grok 的目录 Session Spine 做外皮，用 Qoder/Claude 的 meta+jsonl 做互操作，用 Neo 的 DB+安全+LLM 观测做内核。**


---

## 19. Pi Agent 会话模型对照（2026-08-05）

> 证据：Pi 官方 Session Format / Sessions 文档（`earendil-works/pi` / `pi-mono`，gh API 全文）、作者理念与既有 Neo 研究 `docs/research/2026-07-26-pi-agent-principles-vs-neo-agent-architecture.md`。  
> 本机 `~/.pi/agent` 仅有 settings + skills，**几乎无历史 session 文件**；设计判断以官方格式与 SessionManager API 为准。

### 19.1 一句话定性

**Pi 的日志/会话哲学 =「单文件 append-only **entry 树**」**：不是 Claude 的线性 transcript，也不是 Grok 的多文件目录，而是 **在同一 JSONL 里用 `id`/`parentId` 表达分支**，compaction / model change / extension state 都是一等 entry。

这是对 Neo Session Spine 最有杀伤力的补强点之一——你们 7 月研究已点名「平面 messages + rewound 隐藏 / truncate 删历史」的债，Pi 给出了可落地的 canonical 形态。

### 19.2 存储与产品面（官方）

| 项 | Pi |
|----|-----|
| 路径 | `~/.pi/agent/sessions/--<cwd-with-/>-/<timestamp>_<uuid>.jsonl` |
| 格式 | JSONL；header `type:session` + version；其余 entry 带 `id`/`parentId` |
| 版本 | v1 线性 → v2 树 → v3 custom 角色；**load 时自动 migrate** |
| 无痕 | `pi --no-session` / `SessionManager.inMemory()` |
| Resume | `pi -c` 最近；`pi -r` picker；`--session` / `--fork` |
| 树导航 | `/tree` 跳 leaf；可选 branch summary |
| 新文件分支 | `/fork` `/clone`；树内分支不新建文件 |
| 导出 | `/export` HTML；`/share` private gist |
| 删除 | trash CLI 优先 |
| 宿主 | TUI / SDK / print / JSON event stream / RPC **同一 AgentSession** |

### 19.3 Entry 类型（日志 = 事件账本，不止消息）

| type | 含义 | 是否进 LLM context |
|------|------|-------------------|
| `session` header | id/cwd/version/parentSession | 否（元数据） |
| `message` | user / assistant / toolResult / bashExecution / … | 是（路径上） |
| `model_change` | 中途换模型 | 影响后续构建 |
| `thinking_level_change` | 推理档位 | 影响后续构建 |
| `compaction` | 压缩；可带 `retainedTail` 自包含检查点 | summary + tail |
| `branch_summary` | 离开分支时的摘要 | 是 |
| `custom` | **扩展状态，不进 LLM** | 否 |
| `custom_message` | 扩展注入，可进 LLM | 可选 display |
| `label` | 书签 | 否 |
| `session_info` | 显示名 | 否 |

**Context 构建**：从 **当前 leaf 走 parent 到 root**，遇 compaction 用 `retainedTail` 或 `firstKeptEntryId` 截断——**不重放全文件、不删旧 entry**。

### 19.4 与 Grok / Claude / Qoder / Neo 的位置

| | Claude/Qoder | Grok | **Pi** | Neo 现状 | Neo Spine 目标 |
|--|--------------|------|--------|----------|----------------|
| 形态 | 线性 jsonl（±meta） | **多文件目录** | **单文件 entry 树** | 平面 SQLite messages | 目录 + **entry 树语义** |
| 分支 | 弱 / 新 session | fork 新 session | **同文件 in-place 树** | rewound 隐藏 / 偶发 truncate | append-only 分支 |
| Compaction | 副作用多 | compaction_checkpoints | **一等 entry + retainedTail** | CompressionState 投影 | entry 化 |
| 扩展状态 | 弱 | 弱 | **custom entry** | 散 | custom lane |
| Resume 权威 | jsonl 线性 | updates.jsonl | leaf + 树 | DB | 投影 leaf |
| 模型视图 | 混在消息 | chat_history 分轨 | buildSessionContext 投影 | ProjectionEngine | 保持投影 |
| 深度观测 | 弱 | events/signals/OTel | 中（事件流 API） | 强 telemetry | 保持 |
| 树 UI | 无 | 弱 | **`/tree` 一等** | 弱 | Timeline 可升树 |

### 19.5 对完整方案的增量修订（§17–18 之上）

#### A. Canonical 语义升级（最重要）

原稿：SQLite 权威 + 线性 transcript 镜像。  
**Pi 补强**：

- Canonical **execution history** 应是 **append-only entry log（带 parentId）**，不是「可变 messages 行」。  
- SQLite 继续：查询、FTS、同步、UI 投影（与 7 月研究 Decision Gate B 一致）。  
- 禁止把 rewind 做成**物理 DELETE 后半段**（Pi 从不删 entry；只移动 leaf）。Neo 的 `truncateMessagesAfter` 类路径应收敛为「投影 leaf 变更 + 可选 branch 标记」。

#### B. Transcript / updates 行模型

在 `TranscriptLine` / 镜像格式中**强制**：

```ts
{
  v: 1,
  type: 'entry',           // 或细分 message|compaction|...
  id: string,              // 稳定 entry id（uuid 或 8-hex）
  parentId: string | null,
  kind: 'message' | 'compaction' | 'model_change' | 'permission' | 'label' | 'custom' | ...,
  at: number,
  // payload...
}
```

- `leafId` 写入 `summary.json`（当前活动位置）。  
- 导出包 `timeline.jsonl` 默认 = **active branch**（leaf→root）；可选 `tree.json` 全树。  
- 诊断包增加 `leafId` / `branchPath[]`。

#### C. Compaction / Branch 一等事件

| Pi | Neo 落点 |
|----|----------|
| `compaction` + `retainedTail` | 已有 CompressionState → **同时 append spine entry**；包内可重建「模型看见什么」 |
| `branch_summary` | rewind/fork 换路径时可选 LLM/规则摘要 entry |
| `model_change` | 换模型写 entry（telemetry 已有则双写 id） |
| `label` | 用户书签 / eval 锚点 |

#### D. Extension / 产品对象边界

Pi：`custom` 不进 LLM，`custom_message` 才进。  
Neo：Goal/Artifact/Hook 活动应落 **custom 类 entry 或独立 lane**，避免继续塞进 RuntimeContext 污染「模型历史」与「执行历史」边界（与 Pi 理念 4.1/4.3 一致，但是日志层落地）。

#### E. 产品命令面

对齐 Pi（不必同名）：

- 会话树浏览（Timeline 升级为可折叠树 + leaf 指示）  
- 命名 session（summary.name）  
- ephemeral 跑批  
- export HTML（md/zip 之外的人读形态）  
- `--no-session` 等价  

#### F. 与 Grok 目录如何共存（决议）

**推荐混合（不二选一）**：

```
sessions/<cwd>/<sessionId>/
  summary.json          # leafId, name, git, costs  (Grok)
  entries.jsonl         # ★ Pi 式 append-only 树（canonical 文件投影）
  events.jsonl          # 高频 phase（Grok；可与 entries 合并策略另议）
  signals.json          # 聚合（Grok）
  chat_history.jsonl    # 可选：当前 leaf 的模型视图物化（debug）
```

- **权威写**：SQLite entry 表（或 messages 升级为 entry）append-only  
- **文件投影**：`entries.jsonl` = Pi 树；列表只读 `summary`  
- **导出 zip**：目录打包 + audit 链 + log 窗  

高频 `phase_changed`（Grok events 里 3k+）**不要**全部进 entries 树——entries 保「可分支的执行语义」；events 保「可观测噪声」。这是 Grok 拆分 + Pi 树 的正确合成。

#### G. 阶段微调

| Phase | 增补 |
|-------|------|
| 0 | entry id/parentId/leaf 契约；禁 truncate 新路径 |
| 1 | 镜像/包使用 entry 树；active branch 导出 |
| 2 | Timeline → 树视图；label；session name |
| 3 | entries.jsonl 实时 append；migrate 旧线性 messages |
| 7 | 分支对比 eval（两 leaf 成本/工具/结果） |

### 19.6 明确不抄

| 项 | 理由 |
|----|------|
| 砍掉 SQLite 只留 jsonl | Neo 桌面同步/FTS/多 surface 需要投影库 |
| 默认极简权限/无产品内核 | Pi 定位不同；Goal/Artifact 仍是 Neo 产品 |
| 单文件塞满 phase 事件 | 与 Grok 细粒度 events 冲突；会胀树 |
| 8-char hex id | 可用 uuid；稳定可 join 即可 |

### 19.7 结论

Pi 补上了前几轮对照里缺的那一块：

> **「可搬运」不够，还要「可分支、可压缩、可扩展、且永不篡改历史」。**

- Grok 教 Neo：**目录 Spine + signals + OTel 门控**  
- Qoder/Claude 教 Neo：**meta + 线性互操作**  
- WorkBuddy 教 Neo：**审计哈希链 + 支持 zip**  
- **Pi 教 Neo：append-only entry 树 + compaction/branch 一等 entry + leaf 导航**  

完整方案最终合成句：

> **SQLite（及 entry 表）append-only 为权威；磁盘用 Grok 式目录投影；entries.jsonl 用 Pi 式树；审计用 WorkBuddy 链；导出 zip 给人/支持；OTel/Langfuse 分轨出站。**

---

## 20. 全产品对照总表（补齐 WorkBuddy / Codex）

> 说明：§19.4 为突出 Pi 的「entry 树」只列了 Claude/Qoder · Grok · Pi · Neo，**不是**否定 WorkBuddy/Codex。下表为会话/日志维度的**完整对照**（本调研全员）。

### 20.1 存储与会话主脊

| 维度 | Claude Code | Codex | WorkBuddy | Qoder | Grok Build | Pi Agent | Neo 现状 | Neo 目标（本方案） |
|------|-------------|-------|-----------|-------|------------|----------|----------|-------------------|
| 会话主脊 | 项目下线性 jsonl | `sessions/YYYY/MM/DD/rollout-*.jsonl` 事件流 | 项目下 jsonl（Claude 族） | jsonl + `*-session.json` meta | **目录多文件** | **单文件 entry 树** | SQLite messages 平面 | SQLite entry 权威 + 目录投影 |
| Resume 权威 | 同 jsonl 追加 | rollout 整文件 | 同 jsonl | 同 jsonl | `updates.jsonl` | leaf + parentId 树 | DB | 投影 entries + leaf |
| 分支 | 弱 / 新 session | fork/thread 级 | 弱 | `parent_session_id` | fork 新 session | **同文件 in-place 树** | rewound / 偶 truncate | append-only 树，禁物理删历史 |
| 索引/列表 | history.jsonl | session_index + 日分片 | DB + project 目录 | meta 旁路 | summary + SQLite FTS | resume picker + name | FTS 表 | summary + FTS + CLI search |
| 无痕/临时 | SKIP_PROMPT_HISTORY | ephemeral session | 弱可见 | 弱 | 可配置 telemetry | `--no-session` | 弱 | ephemeral + 无痕开关 |
| 人读导出 | `/export` md | 弱（社区痛） | 历史导出 | 弱 | 目录即读 | HTML + gist | md + 扁 JSON | zip 包 + md + 可选 HTML |

### 20.2 审计 · 工程日志 · 可观测

| 维度 | Claude | Codex | WorkBuddy | Qoder | Grok | Pi | Neo 现状 | Neo 目标 |
|------|--------|-------|-----------|-------|------|-----|----------|----------|
| 安全/权限审计 | 弱产品化 | 事件在 rollout | **哈希链 audit-log** | 弱 | permission 事件 + sandbox-events | 事件流 API | audit JSONL 无链 | **WorkBuddy 级哈希链** |
| 工程日志分仓 | 散文件 | 散 | **按日+子系统** | IDE/Work 分 lane | unified + sandbox | 中 | app 大杂烩 | lane 分仓 |
| 支持一键包 | 拷目录 | 拷 rollout | **帮助→日志 zip** | 散 | 目录=包 | 单 jsonl | 扁 JSON+log 尾 | **目录 zip** |
| LLM/产品观测 | OTel opt-in | 中 | 弱 | 中 | OTel 双门控+内部 telemetry | 中 | **Langfuse+telemetry 厚** | 保持领先 + OTel 可选 |
| 聚合信号 | cost log 等 | 中 | usage 表 | meta tokens/cost | **signals.json** | session 内 usage | telemetry 表 | signals + CostHealth |
| Compaction 入账 | 弱 | 有 compact 事件 | 弱 | 弱 | checkpoints 旁路 | **一等 entry** | CompressionState | entry 化 |
| 子 agent | sidechain | thread/sub | teams | agentId | subagents 目录 | 委托/包 | swarm 强 | 树 + agents/ 入包 |

### 20.3 各家「该抄什么」一览（日志域）

| 产品 | 日志域必抄 | 不必抄 / 后置 |
|------|------------|----------------|
| **Claude** | 可猜路径、开放 jsonl、cleanup 可配、无痕 env、`/export` | 格式当永远稳定；默认删 30 天无提示 |
| **Codex** | rollout 作 resume 真相、按日分片、archive、resume --last、hooks 记 resume/compact | 缺 md 导出、无哈希链 |
| **WorkBuddy** | **审计哈希链**、帮助一键 zip、lane 日志、分批写盘 | 腾讯生态绑定、专家超市 |
| **Qoder** | meta 旁路、parent_session、文件 v1 快照、Work 分 lane | 单 jsonl 无树、支持包弱 |
| **Grok** | **目录 Spine**、updates/chat_history 分轨、signals、sessions FTS CLI、OTel 双门控 | 无决策哈希链、无 Pi 级树 |
| **Pi** | **entry 树 id/parentId**、compaction/branch 一等、leaf 导航、custom 不进 LLM、多宿主同语义 | 砍 SQLite、极简产品内核 |
| **Neo 已领先** | DecisionTrace、Langfuse/telemetry、诊断脱敏、Replay/TurnQuality | 勿为对齐 CLI 降维 |

### 20.4 目标态再收一句

> **Claude/Codex/Qoder 的可搬运与 resume · WorkBuddy 的审计链与支持 zip · Grok 的目录与 OTel 门控 · Pi 的 entry 树 · Neo 自己的安全与 LLM 观测。**

