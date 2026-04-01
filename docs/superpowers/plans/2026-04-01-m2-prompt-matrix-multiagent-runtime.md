# M2: Prompt Matrix + Multi-Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade prompt assembly from static singleton to multi-profile matrix with 5-layer overlays; upgrade subagent from sandboxed container to full child runtime with lifecycle state machine and mailbox coordination.

**Architecture:** Extend builder.ts with profile-based prompt assembly (interactive/oneshot/subagent/fork). Add overlay engine composing 5 layers (substrate/mode/memory/append/projection). Enhance subagentExecutor to rebuild full child context (prompt/tools/permissions/hooks). Add AgentTask state machine with transcript persistence and resume. Add mailbox protocol to AgentBus for worker↔leader coordination.

**Tech Stack:** TypeScript, vitest (testing)

**Design Spec:** `docs/superpowers/specs/2026-04-01-architecture-alignment-design.md` — M2 section

**Depends on:** M1 complete (commit `96ca5f71` on `feat/m1-context-projection`)

---

## Task 1: Overlay Engine + Prompt Profiles (M2-S1 + M2-S2)

Combines S1 and S2 since overlay engine is the mechanism that profiles use.

**Files:**
- Create: `src/main/prompts/overlayEngine.ts`
- Create: `src/main/prompts/profiles.ts`
- Modify: `src/main/prompts/builder.ts`
- Test: `tests/unit/prompts/overlayEngine.test.ts`
- Test: `tests/unit/prompts/profiles.test.ts`

### overlayEngine.ts

```typescript
export type OverlayLayer = 'substrate' | 'mode' | 'memory' | 'append' | 'projection';

export interface OverlayConfig {
  layer: OverlayLayer;
  content: string;
  enabled: boolean;
}

/**
 * Applies overlay layers to a substrate in order.
 * Each layer's content is appended with double-newline separator.
 * Disabled layers are skipped.
 */
export function applyOverlays(substrate: string, overlays: OverlayConfig[]): string {
  let result = substrate;
  for (const overlay of overlays) {
    if (!overlay.enabled || !overlay.content) continue;
    result = `${result}\n\n${overlay.content}`;
  }
  return result;
}
```

### profiles.ts

```typescript
export type PromptProfile = 'interactive' | 'oneshot' | 'subagent' | 'fork';

export interface PromptContext {
  rules?: string[];
  memory?: string[];
  skills?: string[];
  agentFrontmatter?: string;
  parentPrompt?: string;
  forkMessages?: unknown[];
  appendPrompt?: string;
  systemContext?: string;
  userContext?: string;
  mode?: string; // from agentModes
  customSystemPrompt?: string;
}

/**
 * Returns which overlay layers are active for each profile.
 */
export function getProfileOverlays(profile: PromptProfile): Set<OverlayLayer> {
  switch (profile) {
    case 'interactive': return new Set(['substrate', 'mode', 'memory', 'append', 'projection']);
    case 'oneshot': return new Set(['substrate']); // flatten all into substrate
    case 'subagent': return new Set(['substrate', 'mode', 'memory']); // skip append
    case 'fork': return new Set([]); // skip assembly, inherit parent
  }
}
```

### builder.ts changes

- Keep `SYSTEM_PROMPT` singleton for backward compatibility (used by many callers)
- Add new `buildProfilePrompt(profile, context)` alongside existing functions
- `buildProfilePrompt` uses overlayEngine to assemble based on profile
- For `fork` profile: return `context.parentPrompt` directly

```typescript
import { applyOverlays, OverlayConfig } from './overlayEngine';
import { PromptProfile, PromptContext, getProfileOverlays } from './profiles';
import { DYNAMIC_BOUNDARY_MARKER } from './cacheBreakDetection';

export function buildProfilePrompt(profile: PromptProfile, context: PromptContext = {}): string {
  if (profile === 'fork' && context.parentPrompt) {
    return context.parentPrompt; // byte-identical inheritance
  }

  const activeOverlays = getProfileOverlays(profile);

  // L1: Base Substrate (always present)
  const substrate = [getSoul(), TOOLS_PROMPT, ...getToolDescriptions()].join('\n\n');

  const overlays: OverlayConfig[] = [
    {
      layer: 'mode',
      content: context.mode ? getModeReminder(context.mode as AgentMode) : '',
      enabled: activeOverlays.has('mode'),
    },
    {
      layer: 'memory',
      content: [...(context.rules || []), ...(context.memory || [])].join('\n\n'),
      enabled: activeOverlays.has('memory'),
    },
    {
      layer: 'append',
      content: context.appendPrompt || '',
      enabled: activeOverlays.has('append'),
    },
    {
      layer: 'projection',
      content: context.systemContext || '',
      enabled: activeOverlays.has('projection'),
    },
  ];

  // For oneshot: flatten everything into substrate
  if (profile === 'oneshot') {
    const allContent = overlays
      .filter(o => o.content)
      .map(o => o.content)
      .join('\n\n');
    return `${substrate}\n\n${allContent}`;
  }

  // Insert dynamic boundary between substrate and overlays
  const stablePrefix = substrate;
  const dynamicSection = applyOverlays('', overlays);
  return `${stablePrefix}${DYNAMIC_BOUNDARY_MARKER}${dynamicSection}`;
}
```

### Tests

**overlayEngine.test.ts:**
- Returns substrate unchanged when no overlays
- Appends enabled overlays in order
- Skips disabled overlays
- Skips empty content overlays

**profiles.test.ts:**
- `interactive` profile includes all 5 layers
- `oneshot` profile only includes substrate
- `subagent` profile skips append layer
- `fork` profile returns empty set (inherits parent)
- `buildProfilePrompt('fork', {parentPrompt})` returns parentPrompt directly
- `buildProfilePrompt('interactive', {rules, memory})` includes memory overlay
- `buildProfilePrompt('subagent', {rules})` includes rules in memory layer
- `buildProfilePrompt('oneshot', {rules, mode})` flattens everything into single string

- [ ] **Step 1: Write overlayEngine tests**
- [ ] **Step 2: Implement overlayEngine**
- [ ] **Step 3: Run overlayEngine tests**
- [ ] **Step 4: Write profiles + buildProfilePrompt tests**
- [ ] **Step 5: Implement profiles.ts**
- [ ] **Step 6: Add buildProfilePrompt to builder.ts**
- [ ] **Step 7: Run all tests + typecheck**
- [ ] **Step 8: Commit**

```bash
git commit -m "feat(prompts): add overlay engine and profile-based prompt assembly (M2-S1/S2)"
```

---

## Task 2: Subagent Full Context Rebuild (M2-S3)

**Files:**
- Create: `src/main/agent/childContext.ts`
- Modify: `src/main/agent/subagentExecutor.ts`
- Test: `tests/unit/agent/childContext.test.ts`

### childContext.ts

New module that builds a complete child context from parent + config:

```typescript
export interface ParentContext {
  prompt: string;
  rules: string[];
  memory: string[];
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  permissionMode: string;
  modelConfig: { model: string; provider: string };
}

export interface ChildContextConfig {
  agentType: string;
  allowedTools: string[];
  mode?: string;
  hookOverrides?: unknown[];
  mcpFilter?: string[];
  readOnly?: boolean;
}

export interface ChildContext {
  prompt: string;
  toolPool: string[];
  permissions: { preset: string; inherited: string[] };
  hooks: unknown[];
  skills: string[];
  mcpConnections: unknown[];
  memory: string[];
}

export function buildChildContext(config: ChildContextConfig, parent: ParentContext): ChildContext
```

Logic:
- **Prompt**: Call `buildProfilePrompt('subagent', { rules: slimRules, mode: config.mode })`
- **Tool pool**: Filter `config.allowedTools` against parent's available tools
- **Permissions**: Inherit parent's bypassPermissions/acceptEdits (child can't escalate)
- **Hooks**: Inherit parent hooks, apply `config.hookOverrides`
- **Skills**: Resolve by `config.agentType` + parent's skills
- **Memory**: If `config.readOnly`, return slim rules + last 5 memory entries; else full

### subagentExecutor.ts changes

In the `execute()` method, replace the current manual prompt + tool assembly with a call to `buildChildContext()`. The existing `SubagentConfig` interface stays unchanged — `buildChildContext` is called internally.

Key change in `execute()`:
```typescript
// Before (current):
const systemPrompt = config.systemPrompt;
const tools = config.availableTools;

// After:
const childCtx = buildChildContext(
  { agentType: config.name, allowedTools: config.availableTools, readOnly: isReadOnly },
  parentContext,
);
// Use childCtx.prompt as system prompt (or config.systemPrompt if explicitly provided)
// Use childCtx.toolPool for tool filtering
```

### Tests

- `buildChildContext` with readOnly=true → slim memory (max 5 entries)
- `buildChildContext` with readOnly=false → full memory
- Tool pool filtering: child can't have tools parent doesn't have
- Permission inheritance: parent bypass → child inherits
- Permission narrowing: child can restrict further
- Subagent profile used for prompt (not interactive)

- [ ] **Step 1: Write childContext tests**
- [ ] **Step 2: Implement childContext.ts**
- [ ] **Step 3: Run childContext tests**
- [ ] **Step 4: Read subagentExecutor.ts fully**
- [ ] **Step 5: Integrate buildChildContext into execute()**
- [ ] **Step 6: Run existing subagentExecutor tests + typecheck**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(agent): add full child context rebuild for subagents (M2-S3)"
```

---

## Task 3: Agent Task Lifecycle State Machine (M2-S4)

**Files:**
- Create: `src/main/agent/agentTask.ts`
- Test: `tests/unit/agent/agentTask.test.ts`

### agentTask.ts

```typescript
export type AgentTaskStatus = 'pending' | 'registered' | 'running' | 'stopped' | 'resumed' | 'failed' | 'cancelled';

export interface SidecarMetadata {
  agentType: string;
  worktreePath?: string;
  parentSessionId: string;
  spawnTime: number;
  model: string;
  toolPool: string[];
}

export interface TranscriptEntry {
  role: string;
  content: string;
  timestamp: number;
  toolCallId?: string;
}

export class AgentTask {
  readonly id: string;
  status: AgentTaskStatus;
  readonly agentType: string;
  abortController: AbortController | null;
  pendingMessages: Array<{ role: string; content: string }>;
  transcript: TranscriptEntry[];
  sidecarMetadata: SidecarMetadata;

  constructor(id: string, metadata: SidecarMetadata);

  // State transitions
  register(): void;   // pending → registered
  start(): void;       // registered → running, resumed → running
  stop(): void;        // running → stopped
  resume(): void;      // stopped → resumed
  fail(error: string): void;    // running → failed
  cancel(): void;      // any → cancelled

  // Transcript
  appendTranscript(entry: TranscriptEntry): void;

  // Persistence
  async saveToDisk(sessionDir: string): Promise<void>;
  static async loadFromDisk(sessionDir: string, agentId: string): Promise<AgentTask | null>;

  // Message queue
  enqueuePendingMessage(message: { role: string; content: string }): void;
  drainPendingMessages(): Array<{ role: string; content: string }>;
}
```

State machine rules:
- `register()`: only from `pending`
- `start()`: only from `registered` or `resumed`
- `stop()`: only from `running`
- `resume()`: only from `stopped`
- `fail()`: only from `running`
- `cancel()`: from any state except `completed`/`failed`
- Invalid transitions throw `InvalidStateTransitionError`

Persistence:
- `saveToDisk()`: writes `{sessionDir}/agents/{id}/transcript.jsonl` + `{sessionDir}/agents/{id}/metadata.json`
- `loadFromDisk()`: reads back, rebuilds AgentTask instance

### Tests

- State machine transitions (valid and invalid)
- Transcript append and drain
- Pending message queue
- Persistence round-trip (save then load)
- Invalid transition throws

- [ ] **Step 1: Write AgentTask state machine tests**
- [ ] **Step 2: Implement AgentTask class**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Write persistence tests (save/load)**
- [ ] **Step 5: Implement persistence methods**
- [ ] **Step 6: Run all tests + typecheck**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(agent): add AgentTask lifecycle state machine with persistence (M2-S4)"
```

---

## Task 4: Mailbox Coordination Protocol (M2-S5)

**Files:**
- Create: `src/main/agent/mailboxBridge.ts`
- Modify: `src/main/agent/agentBus.ts` (add mailbox protocol)
- Test: `tests/unit/agent/mailboxBridge.test.ts`

### agentBus.ts additions

Add mailbox layer on top of existing pub-sub:

```typescript
// New types
export type MailboxMessageType = 'permission_request' | 'permission_response' | 'task_dispatch' | 'status_report';

export interface MailboxMessage {
  id: string;
  type: MailboxMessageType;
  from: string;
  to: string;
  payload: unknown;
  timestamp: number;
}

// New methods on AgentBus class:
sendMailbox(targetAgentId: string, message: Omit<MailboxMessage, 'id' | 'timestamp'>): void
pollMailbox(agentId: string): MailboxMessage[]
getMailboxSize(agentId: string): number
clearMailbox(agentId: string): void
```

Implementation: internal `Map<string, MailboxMessage[]>` keyed by target agentId. `sendMailbox` appends; `pollMailbox` drains and returns all messages.

### mailboxBridge.ts

Bridge that connects mailbox to the main agent loop:

```typescript
export interface MailboxBridgeConfig {
  agentId: string;
  pollIntervalMs: number; // default: 1000
  onMessage: (message: MailboxMessage) => void;
}

export class MailboxBridge {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private config: MailboxBridgeConfig, private bus: AgentBus);

  start(): void;    // Begin polling
  stop(): void;     // Stop polling
  isActive(): boolean;

  /**
   * Poll once — for use when isLoading=false.
   * Returns messages processed count.
   */
  pollOnce(): number;
}
```

Logic:
- `start()`: sets interval to poll mailbox
- Each poll: if `!isProcessing`, drain mailbox and call `onMessage` for each
- `stop()`: clears interval

### Tests

**mailboxBridge.test.ts:**
- sendMailbox delivers to correct agent
- pollMailbox drains messages
- pollMailbox returns empty after drain
- MailboxBridge.pollOnce processes pending messages
- MailboxBridge doesn't poll while processing
- Multiple agents have independent mailboxes
- Permission request → response round trip

- [ ] **Step 1: Write mailbox protocol tests**
- [ ] **Step 2: Add mailbox methods to AgentBus**
- [ ] **Step 3: Run agentBus tests (regression)**
- [ ] **Step 4: Write MailboxBridge tests**
- [ ] **Step 5: Implement MailboxBridge**
- [ ] **Step 6: Run all tests + typecheck**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat(agent): add mailbox coordination protocol for worker↔leader (M2-S5)"
```

---

## Task 5: Integration — Wire Profiles + Child Context into Agent Loop

**Files:**
- Modify: `src/main/agent/agentLoop.ts` (use buildProfilePrompt)
- Modify: `src/main/agent/runtime/contextAssembly.ts` (profile-aware assembly)
- Modify: `src/main/agent/subagentExecutor.ts` (use AgentTask lifecycle)

### agentLoop.ts changes

In constructor, determine profile based on entry type:
```typescript
// Detect profile from config
const profile: PromptProfile = config.isSubagent ? 'subagent'
  : config.isFork ? 'fork'
  : config.isOneShot ? 'oneshot'
  : 'interactive';

// Use profile-aware prompt if no custom system prompt
if (!config.systemPrompt) {
  ctx.systemPrompt = buildProfilePrompt(profile, {
    rules: loadedRules,
    mode: detectedMode,
  });
}
```

### subagentExecutor.ts changes

In `execute()`, create AgentTask for lifecycle tracking:
```typescript
const task = new AgentTask(agentId, {
  agentType: config.name,
  parentSessionId: context.sessionId,
  spawnTime: Date.now(),
  model: config.model || parentModel,
  toolPool: config.availableTools,
});
task.register();
task.start();

try {
  // ... existing execution logic ...
  // Append to transcript during execution
  task.appendTranscript({ role: 'assistant', content: result.output, timestamp: Date.now() });
  task.stop();
} catch (error) {
  task.fail(error.message);
}
```

### Notes

- This is MINIMAL integration — add new capabilities alongside existing ones
- Don't restructure existing control flow
- Profile detection uses existing config flags where available
- AgentTask lifecycle wraps existing execution, doesn't replace it

- [ ] **Step 1: Read all three files to understand integration points**
- [ ] **Step 2: Add profile detection to agentLoop.ts**
- [ ] **Step 3: Add AgentTask lifecycle to subagentExecutor.ts**
- [ ] **Step 4: Typecheck**
- [ ] **Step 5: Run existing tests (regression check)**
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(agent): wire prompt profiles and AgentTask into agent loop (M2 integration)"
```

---

## Verification Checklist (M2 Complete)

After all 5 tasks:

- [ ] `npm run typecheck` — no errors
- [ ] `npx vitest run` — all new tests pass, no regressions in existing tests
- [ ] `buildProfilePrompt('interactive')` produces same content as old `SYSTEM_PROMPT` (backward compat)
- [ ] `buildProfilePrompt('subagent')` produces a shorter, focused prompt
- [ ] `buildProfilePrompt('fork', {parentPrompt})` returns parent prompt unchanged
- [ ] AgentTask state transitions enforce valid paths
- [ ] Mailbox round-trip: send permission_request → poll → respond
- [ ] `git log --oneline` — 5 clean commits
