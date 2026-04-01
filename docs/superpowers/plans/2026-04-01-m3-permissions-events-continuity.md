# M3: Permissions Matrix + Event Channels + Continuity Protocol

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade permissions from linear rule evaluation to multi-source competition matrix with topology awareness; split single EventBus into 3 channels (internal/control/mailbox); add worker epoch generation fence to session continuity.

**Architecture:** Create guardFabric.ts as multi-source coordinator over existing policyEngine. Split eventBus into InternalEventStore (persistent) + ControlStream (realtime) + Mailbox (M2). Add workerEpoch field to session state with mismatch detection. Implement rematerialization (snapshot-based resume).

**Tech Stack:** TypeScript, vitest

**Design Spec:** `docs/superpowers/specs/2026-04-01-architecture-alignment-design.md` — M3 section

**Depends on:** M1 + M2 complete

---

## Task 1: Multi-Source Guard Fabric (M3-S1 + M3-S2)

**Files:**
- Create: `src/main/permissions/guardFabric.ts`
- Create: `src/main/permissions/hookSource.ts`
- Create: `tests/unit/permissions/guardFabric.test.ts`

### guardFabric.ts

Multi-source permission coordinator that sits ABOVE the existing policyEngine:

```typescript
export type GuardVerdict = 'allow' | 'deny' | 'ask';
export type ExecutionTopology = 'main' | 'async_agent' | 'teammate' | 'coordinator';

export interface GuardSource {
  name: string;
  evaluate(request: GuardRequest): GuardSourceResult | null;
}

export interface GuardRequest {
  tool: string;
  args: Record<string, unknown>;
  topology: ExecutionTopology;
  sessionId?: string;
  agentId?: string;
}

export interface GuardSourceResult {
  verdict: GuardVerdict;
  confidence: number; // 0-1
  source: string;
  reason: string;
}

export interface GuardDecision {
  verdict: GuardVerdict;
  source: string;
  reason: string;
  allResults: GuardSourceResult[];
}

export class GuardFabric {
  private sources: GuardSource[] = [];

  registerSource(source: GuardSource): void;
  removeSource(name: string): void;

  evaluate(request: GuardRequest): GuardDecision;
}
```

Competition rules:
- All sources evaluate in parallel (synchronous, fast)
- Collect non-null results
- **deny** wins over **ask** wins over **allow** (at same or higher confidence)
- Among same verdict level, first source wins
- If no sources return a result → default to 'ask'

Topology awareness (M3-S2):
- `async_agent` topology: `bash` → deny (no interactive approval), `write` → ask
- `coordinator` topology: `bash`/`write` → deny, `spawn_agent` → allow
- `main`/`teammate` topology: normal rules apply
- Fail semantics: interactive topologies (main/teammate) → fail-open to 'ask'; headless (async_agent) → fail-closed to 'deny'

### hookSource.ts

Wraps hook system as a GuardSource:

```typescript
export class HookGuardSource implements GuardSource {
  name = 'hooks';
  evaluate(request: GuardRequest): GuardSourceResult | null;
}
```

Checks if any PreToolUse hook would allow/deny the tool. Returns null if no hooks configured.

### Existing policyEngine as source

Create a wrapper that adapts policyEngine.evaluate() to GuardSource interface:

```typescript
// Inside guardFabric.ts or separate file
export class PolicyEngineSource implements GuardSource {
  name = 'rules';
  evaluate(request: GuardRequest): GuardSourceResult | null {
    const result = getPolicyEngine().evaluate({
      tool: request.tool, level: 'tool', ...
    });
    return { verdict: result.action as GuardVerdict, confidence: 1.0, source: 'rules', reason: result.reason };
  }
}
```

### Tests (~20)

- deny wins over ask
- ask wins over allow
- First source wins among same verdict
- No sources → default ask
- Topology: async_agent + bash → deny
- Topology: coordinator + write → deny
- Topology: main + bash → ask (from rules)
- bypassPermissions: safety rules still have immunity
- PolicyEngineSource wraps correctly
- HookSource returns null when no hooks

- [ ] **Step 1: Write guardFabric tests**
- [ ] **Step 2: Implement guardFabric + PolicyEngineSource + topology matrix**
- [ ] **Step 3: Implement hookSource**
- [ ] **Step 4: Run tests + typecheck**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(permissions): add multi-source guard fabric with topology awareness (M3-S1/S2)"
```

---

## Task 2: Event Three-Channel Split (M3-S3 + M3-S4)

**Files:**
- Create: `src/main/events/internalEventStore.ts`
- Create: `src/main/events/controlStream.ts`
- Create: `src/main/events/eventReplay.ts`
- Modify: `src/main/events/eventBus.ts` (delegate to channels)
- Test: `tests/unit/events/internalEventStore.test.ts`
- Test: `tests/unit/events/eventReplay.test.ts`

### internalEventStore.ts

Persistent event storage with at-least-once delivery:

```typescript
export interface StoredEvent {
  eventId: string;
  agentId: string;
  domain: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export class InternalEventStore {
  private events: StoredEvent[] = [];
  private seenIds = new Set<string>();

  writeEvent(event: Omit<StoredEvent, 'eventId'>): string; // returns eventId
  readEvents(filter?: { domain?: string; type?: string; agentId?: string; since?: number }): StoredEvent[];
  getEventCount(): number;

  // Persistence
  async flush(filePath: string): Promise<void>; // append to JSONL
  static async loadFromFile(filePath: string): Promise<InternalEventStore>;
}
```

- eventId generated as UUID-like string
- Dedup via seenIds set (at-least-once → exactly-once on read)
- Sub-agent events filtered by agentId

### controlStream.ts

Thin wrapper for real-time push (replaces EventBridge's forwarding role):

```typescript
export class ControlStream {
  push(event: { domain: string; type: string; data: unknown }): void;
  subscribe(handler: (event: unknown) => void): () => void;
}
```

No persistence, no dedup. Best-effort delivery. This is what the UI subscribes to.

### eventReplay.ts

Replay events from InternalEventStore for debug/evaluation:

```typescript
export class EventReplay {
  constructor(store: InternalEventStore);
  replay(filter?: { agentId?: string; timeRange?: [number, number] }): StoredEvent[];
  getTimeline(): Array<{ timestamp: number; domain: string; type: string; summary: string }>;
}
```

### eventBus.ts changes

MINIMAL: Keep existing EventBus. Add routing to InternalEventStore for persistence-worthy events (tool execution, permission decisions, state changes). ControlStream replaces the direct EventBridge forwarding.

```typescript
// In EventBus.publish():
// After existing emit logic, also write to internalEventStore if domain is 'tool' or 'agent'
if (['tool', 'agent', 'session'].includes(domain)) {
  this.internalStore?.writeEvent({ agentId: options?.agentId || 'main', domain, type, data, timestamp });
}
```

### Tests (~15)

- InternalEventStore: write + read, dedup, filter by domain/agentId/since
- InternalEventStore: flush to JSONL + load from file round-trip
- EventReplay: replay with filter, timeline generation
- ControlStream: push + subscribe + unsubscribe

- [ ] **Step 1: Write InternalEventStore tests**
- [ ] **Step 2: Implement InternalEventStore**
- [ ] **Step 3: Write EventReplay tests**
- [ ] **Step 4: Implement EventReplay + ControlStream**
- [ ] **Step 5: Integrate into EventBus (minimal routing)**
- [ ] **Step 6: Run all tests + typecheck**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(events): split into 3 channels — internal store, control stream, mailbox (M3-S3/S4)"
```

---

## Task 3: Worker Epoch + Rematerialization (M3-S5 + M3-S6)

**Files:**
- Create: `src/main/session/workerEpoch.ts`
- Modify: `src/main/session/resume.ts` (add rematerialization path)
- Test: `tests/unit/session/workerEpoch.test.ts`

### workerEpoch.ts

Generation fence preventing concurrent writers:

```typescript
export class EpochMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(`Epoch mismatch: expected ${expected}, got ${actual}`);
  }
}

export class WorkerEpoch {
  private currentEpoch: number = 0;

  increment(): number; // returns new epoch
  getCurrent(): number;
  validate(epoch: number): void; // throws EpochMismatchError if mismatch

  /**
   * Wrap a write operation with epoch validation.
   * If epoch changed since start, operation is rejected.
   */
  guardedWrite<T>(epoch: number, fn: () => T): T;
}

let instance: WorkerEpoch | null = null;
export function getWorkerEpoch(): WorkerEpoch;
export function resetWorkerEpoch(): void;
```

### resume.ts changes

Add rematerialization as alternative to transcript replay:

```typescript
import { CompressionState } from '../context/compressionState';
import { WorkerEpoch, getWorkerEpoch } from './workerEpoch';

// In resumeSession() or SessionResumeManager:
// Add a new path: if checkpoint snapshot available, use rematerialization
// instead of replaying all messages

export async function rematerializeFromSnapshot(
  snapshot: { messages: Message[]; compressionState?: string; epoch?: number },
): Promise<ResumedContext> {
  // 1. Increment worker epoch
  const epoch = getWorkerEpoch().increment();

  // 2. Restore compression state if available
  let compressionState: CompressionState | undefined;
  if (snapshot.compressionState) {
    compressionState = CompressionState.deserialize(snapshot.compressionState);
  }

  // 3. Build context directly from snapshot (no replay)
  return {
    sessionId: snapshot.sessionId,
    messages: snapshot.messages,
    compressionState,
    epoch,
    metadata: { ... },
  };
}
```

Consistency check:
```typescript
export function checkResumeConsistency(
  snapshotMessageCount: number,
  actualTranscriptLines: number,
): { consistent: boolean; drift: number } {
  const drift = Math.abs(snapshotMessageCount - actualTranscriptLines);
  return { consistent: drift <= 2, drift }; // allow small drift
}
```

### Tests (~15)

- WorkerEpoch: increment, validate pass, validate fail (throws)
- guardedWrite: succeeds with matching epoch, fails with mismatched
- Multiple increments track correctly
- rematerializeFromSnapshot: restores messages and compression state
- checkResumeConsistency: consistent when counts match, inconsistent when drift > 2

- [ ] **Step 1: Write WorkerEpoch tests**
- [ ] **Step 2: Implement WorkerEpoch**
- [ ] **Step 3: Write rematerialization tests**
- [ ] **Step 4: Implement rematerializeFromSnapshot + checkResumeConsistency**
- [ ] **Step 5: Run all tests + typecheck**
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(session): add worker epoch fence and snapshot rematerialization (M3-S5/S6)"
```

---

## Verification Checklist (M3 Complete)

- [ ] `npm run typecheck` — no errors
- [ ] All new tests pass, no regressions
- [ ] GuardFabric: deny > ask > allow competition works
- [ ] GuardFabric: topology changes verdict (async_agent + bash → deny)
- [ ] InternalEventStore: write + read + flush + load round-trip
- [ ] WorkerEpoch: mismatch throws, guarded write rejects stale epoch
- [ ] `git log --oneline` — 3 clean commits
