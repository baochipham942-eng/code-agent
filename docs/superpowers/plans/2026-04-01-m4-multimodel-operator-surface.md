# M4: Multi-Model Routing Integration + Operator Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed CA's 12-provider multi-model advantage into core paths (compression model routing, intelligent fallback, per-agent-type model assignment); build real-time operator surface (TokenWarning, ContextVisualization, /doctor command).

**Architecture:** Create compressionModelRouter for selecting cheap models for context compression. Enhance adaptiveRouter with reason-aware fallback selection. Add agentModelPolicy for per-type model defaults. Build request normalization middleware. Create operator UI components and /doctor diagnostic command.

**Tech Stack:** TypeScript, React, Tailwind CSS, vitest

**Design Spec:** `docs/superpowers/specs/2026-04-01-architecture-alignment-design.md` — M4 section

**Depends on:** M1 + M2 + M3 complete

---

## Task 1: Compression Model Router (M4-S1)

**Files:**
- Create: `src/main/context/compressionModelRouter.ts`
- Test: `tests/unit/context/compressionModelRouter.test.ts`

### compressionModelRouter.ts

Selects the cheapest appropriate model for each compression layer:

```typescript
import { DEFAULT_MODELS } from '../../shared/constants';

export interface CompressionModelConfig {
  provider: string;
  model: string;
}

export interface CompressionModelRouterConfig {
  /** User override for compression model */
  userPreference?: CompressionModelConfig;
  /** Available providers (for fallback) */
  availableProviders?: string[];
}

/**
 * Layer → model mapping. L1-L3 don't use models. L4-L5 use cheap models.
 */
const LAYER_MODEL_DEFAULTS: Record<string, CompressionModelConfig> = {
  contextCollapse: { provider: 'zhipu', model: 'glm-4-flash' },   // cheapest, fast
  autocompact: { provider: 'moonshot', model: 'kimi-k2.5' },       // stronger summary for fallback layer
};

export class CompressionModelRouter {
  private config: CompressionModelRouterConfig;

  constructor(config?: CompressionModelRouterConfig);

  /**
   * Select model for a compression layer.
   * Returns null for layers that don't need a model (L1-L3, L6).
   */
  selectModel(layer: string): CompressionModelConfig | null;

  /**
   * Update user preference (from settings).
   */
  setPreference(config: CompressionModelConfig): void;
}
```

Logic:
- User preference overrides defaults for all model-using layers
- L1/L2/L3/L6 return null (no model needed)
- L4 (contextCollapse) → zhipu/glm-4-flash (cheapest)
- L5 (autocompact) → moonshot/kimi-k2.5 (better summary quality)

### Tests (~10)

- L1/L2/L3/L6 return null
- L4 returns zhipu/glm-4-flash by default
- L5 returns moonshot/kimi-k2.5 by default
- User preference overrides defaults
- setPreference changes subsequent selections

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify + commit**

```bash
git commit -m "feat(context): add compression model router for cheap model selection (M4-S1)"
```

---

## Task 2: Intelligent Fallback Router (M4-S2)

**Files:**
- Modify: `src/main/model/adaptiveRouter.ts` — add `selectFallback()` method
- Test: `tests/unit/model/adaptiveRouter.test.ts` (extend)

### adaptiveRouter.ts additions

Add `selectFallback()` to the existing AdaptiveRouter class:

```typescript
export interface FallbackContext {
  reason: 'context_overflow' | 'rate_limit' | 'unavailable' | 'auth' | 'network';
  currentModel: string;
  currentProvider: string;
  taskCapabilities?: string[]; // e.g. ['code', 'reasoning']
  budgetRemaining?: number; // 0-1
}

export interface FallbackResult {
  provider: string;
  model: string;
  contextWindow: number;
  reason: string;
}

// Add to AdaptiveRouter class:
selectFallback(context: FallbackContext): FallbackResult | null {
  switch (context.reason) {
    case 'context_overflow':
      // Select model with larger context window
      return this.findLargerContextModel(context);
    case 'rate_limit':
      // Select same-capability different provider
      return this.findAlternateProvider(context);
    case 'unavailable':
    case 'network':
      // Walk PROVIDER_FALLBACK_CHAIN
      return this.walkFallbackChain(context);
    case 'auth':
      return null; // Can't recover from auth errors by switching
  }
}
```

Helper methods (private):
- `findLargerContextModel()`: Look up CONTEXT_WINDOWS, find model with window > current
- `findAlternateProvider()`: Pick next provider from PROVIDER_FALLBACK_CHAIN that isn't current
- `walkFallbackChain()`: Iterate PROVIDER_FALLBACK_CHAIN, skip current, return first available

### Tests (~10)

- context_overflow → returns model with larger context window
- rate_limit → returns different provider with same capabilities
- unavailable → walks fallback chain
- auth → returns null
- Budget-aware: low budget → prefers cheaper model
- No fallback available → returns null

- [ ] **Step 1: Write selectFallback tests**
- [ ] **Step 2: Implement selectFallback + helpers**
- [ ] **Step 3: Verify + run existing adaptiveRouter tests**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(model): add intelligent fallback selection by failure reason (M4-S2)"
```

---

## Task 3: Agent Model Policy (M4-S3)

**Files:**
- Create: `src/main/agent/agentModelPolicy.ts`
- Test: `tests/unit/agent/agentModelPolicy.test.ts`

### agentModelPolicy.ts

Per-agent-type model selection:

```typescript
export interface AgentModelSelection {
  provider: string;
  model: string;
  reason: string;
}

const AGENT_MODEL_DEFAULTS: Record<string, { provider: string; model: string; reason: string }> = {
  'Code Explorer': { provider: 'moonshot', model: 'kimi-k2.5', reason: '128k window, strong code comprehension' },
  'Code Reviewer': { provider: 'deepseek', model: 'deepseek-reasoner', reason: 'transparent reasoning chain' },
  'Web Search': { provider: 'perplexity', model: 'sonar-pro', reason: 'native search integration' },
  'Document Reader': { provider: 'zhipu', model: 'glm-4-flash', reason: 'cheap and fast' },
  'Technical Writer': { provider: 'moonshot', model: 'kimi-k2.5', reason: 'strong Chinese writing' },
  'Debugger': { provider: 'deepseek', model: 'deepseek-reasoner', reason: 'complex reasoning' },
};

export function selectAgentModel(
  agentType: string,
  options?: { budgetRemaining?: number; userOverride?: Record<string, { provider: string; model: string }> },
): AgentModelSelection;
```

Logic:
- User overrides take precedence
- Then AGENT_MODEL_DEFAULTS lookup by agentType
- Budget-aware: if budgetRemaining < 0.2, switch to cheapest model (zhipu/glm-4-flash)
- Unknown agent type → return default model from constants

### Tests (~10)

- Known agent type returns configured model
- Unknown agent type returns default
- User override takes precedence
- Low budget → cheapest model
- Budget threshold boundary (0.2)

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify + commit**

```bash
git commit -m "feat(agent): add per-agent-type model policy with budget awareness (M4-S3)"
```

---

## Task 4: Request Normalization Middleware (M4-S4)

**Files:**
- Create: `src/main/model/middleware/requestNormalizer.ts`
- Test: `tests/unit/model/requestNormalizer.test.ts`

### requestNormalizer.ts

Unified pre-processing layer for all provider requests:

```typescript
export interface NormalizedRequest {
  messages: Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }>;
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  model: string;
  provider: string;
  maxTokens?: number;
  temperature?: number;
  betaFlags?: string[];
  cacheControl?: { ttl: number; prefix: string };
}

export function normalizeMessages(messages: unknown[], provider: string): NormalizedRequest['messages'];
export function toolToAPISchema(tools: unknown[], provider: string): NormalizedRequest['tools'];
export function applyBetaFlags(request: NormalizedRequest, model: string): NormalizedRequest;
export function applyCacheTTL(request: NormalizedRequest, bootstrapState: boolean): NormalizedRequest;
```

Key normalizations:
- `normalizeMessages`: Ensure content is string or content-parts array per provider spec
- `toolToAPISchema`: Convert internal tool format to provider-specific schema
- `applyBetaFlags`: Add beta headers for models that support them
- `applyCacheTTL`: Lock cache eligibility to bootstrap state (don't flip mid-session)

### Tests (~12)

- normalizeMessages: string content passes through
- normalizeMessages: content-parts converted for providers that need string-only
- toolToAPISchema: internal format → OpenAI format
- toolToAPISchema: internal format → Anthropic format
- applyBetaFlags: adds flags for supported models
- applyBetaFlags: no flags for unsupported models
- applyCacheTTL: bootstrap=true → sets cache control
- applyCacheTTL: bootstrap=false → no cache control (don't flip)

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify + commit**

```bash
git commit -m "feat(model): add request normalization middleware for provider unification (M4-S4)"
```

---

## Task 5: Operator Surface — TokenWarning + ContextVisualization (M4-S5)

**Files:**
- Create: `src/renderer/components/TokenWarning.tsx`
- Create: `src/renderer/components/ContextVisualization.tsx`
- Modify: `src/renderer/components/StatusBar/index.tsx` (add TokenWarning)

### TokenWarning.tsx

Dynamic indicator that changes display based on compression state:

```tsx
interface TokenWarningProps {
  usagePercent: number;
  currentLayer?: string; // e.g. 'L2:snip', 'L4:contextCollapse'
  isCompressing?: boolean;
  fallbackModel?: string;
}

// Display logic:
// Normal (< 60%): green percentage
// Warning (60-85%): yellow percentage  
// Compressing: yellow pulse + layer name
// Overflow recovery: red + fallback model name
```

### ContextVisualization.tsx

Expandable panel (already created ContextPanel.tsx in M1-Task 6, this extends it):

- Token distribution bar chart (horizontal stacked bar)
- Compression timeline (list of triggered layers with timestamps)
- Active sub-agents list with status
- Deferred tools count

### StatusBar integration

Add TokenWarning component to StatusBar, between ContextUsage and SessionDuration.

### Tests

No unit tests for React components (visual verification). Typecheck only.

- [ ] **Step 1: Create TokenWarning.tsx**
- [ ] **Step 2: Create ContextVisualization.tsx**
- [ ] **Step 3: Integrate TokenWarning into StatusBar**
- [ ] **Step 4: Typecheck**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ui): add TokenWarning indicator and ContextVisualization panel (M4-S5)"
```

---

## Task 6: /doctor Diagnostic Command (M4-S6)

**Files:**
- Create: `src/main/ipc/doctor.ipc.ts`
- Create: `src/cli/commands/doctor.ts` (if CLI command structure supports it)
- Test: `tests/unit/ipc/doctor.ipc.test.ts`

### doctor.ipc.ts

```typescript
export interface DiagnosticItem {
  category: 'environment' | 'network' | 'config' | 'database' | 'disk';
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

export interface DiagnosticReport {
  timestamp: number;
  items: DiagnosticItem[];
  summary: { pass: number; warn: number; fail: number };
}

export async function runDiagnostics(): Promise<DiagnosticReport>;
```

Diagnostic checks:
- **Environment**: Node version (≥18), Rust toolchain (for Tauri), Python3 (for ASR)
- **Network**: Proxy connectivity (127.0.0.1:7897), sample API endpoint reach
- **Config**: API keys present (check env vars), MCP server config valid
- **Database**: SQLite integrity check, Supabase connection (if configured)
- **Disk**: Session directory size, log directory size, available space

Each check returns pass/warn/fail independently. Report aggregates.

### Tests (~8)

- Returns structured DiagnosticReport
- Environment checks return pass for current Node version
- Missing optional tool → warn (not fail)
- Summary counts correct

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement runDiagnostics**
- [ ] **Step 3: Register IPC handler**
- [ ] **Step 4: Typecheck + test**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(operator): add /doctor diagnostic command with structured report (M4-S6)"
```

---

## Verification Checklist (M4 Complete)

- [ ] `npm run typecheck` — no errors
- [ ] All new tests pass
- [ ] CompressionModelRouter: L4 → zhipu, L5 → moonshot, L1-L3 → null
- [ ] selectFallback: overflow → larger context model, rate_limit → different provider
- [ ] selectAgentModel: known types get configured models, low budget → cheapest
- [ ] TokenWarning: displays different states (normal/warning/compressing/overflow)
- [ ] /doctor: returns structured report with pass/warn/fail items
- [ ] `git log --oneline` — 6 clean commits
