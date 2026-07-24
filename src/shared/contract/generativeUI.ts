// ============================================================================
// Agent Neo Generative UI v1 — model declaration and host-owned runtime types
// ============================================================================

// ponytail: internal-only exports de-exported to satisfy knip ratchet; re-export
// each alongside its first external consumer (net-zero on the ratchet at that time).
const NEO_UI_SCHEMA_VERSION = 1 as const;
const NEO_UI_MAX_SPEC_BYTES = 64 * 1024;
export const NEO_UI_MAX_STATE_BYTES = 16 * 1024;
export const NEO_UI_MAX_EVENT_BYTES = 32 * 1024;
const NEO_UI_MAX_NODES = 32;
const NEO_UI_MAX_DEPTH = 8;
const NEO_UI_MAX_STRING_LENGTH = 20_000;

const NEO_UI_COMPONENT_TYPES = [
  'ChoiceGroup',
  'ParameterGroup',
  'MetricSummary',
  'StepperFlow',
  'DiffReview',
  'ExecutionScope',
  'ExecutionDecision',
] as const;

type NeoUIComponentType = typeof NEO_UI_COMPONENT_TYPES[number];

const NEO_UI_MODEL_INTENTS = [
  'state.update',
  'conversation.fill',
  'conversation.send',
  'operation.request',
  'disclosure.toggle',
  'focus.open',
] as const;

export type NeoUIModelIntent = typeof NEO_UI_MODEL_INTENTS[number];
type NeoUIIntent = NeoUIModelIntent | 'approval.respond';
type NeoUIWidth = 'full' | 'summary';
type NeoUIDisclosure = 'expanded' | 'collapsed' | 'focus';
type NeoUIPriority = 'primary' | 'supporting';

interface NeoUIPresentationV1 {
  width?: NeoUIWidth;
  disclosure?: NeoUIDisclosure;
  priority?: NeoUIPriority;
}

interface NeoUIActionBindingV1 {
  event: 'change' | 'submit' | 'activate' | 'approve' | 'reject';
  intent: NeoUIModelIntent;
  valuePath?: string;
}

export interface NeoUIComponentNodeV1 {
  id: string;
  type: NeoUIComponentType;
  props?: Record<string, unknown>;
  bindings?: Record<string, string>;
  actions?: NeoUIActionBindingV1[];
  children?: NeoUIComponentNodeV1[];
}

/** Model-authored declaration. It deliberately contains no trusted identity. */
export interface NeoUIModelSpecV1 {
  schemaVersion: typeof NEO_UI_SCHEMA_VERSION;
  title?: string;
  summary?: string;
  presentation?: NeoUIPresentationV1;
  initialState?: Record<string, unknown>;
  components: NeoUIComponentNodeV1[];
  fallback: string;
}

export type NeoUIInstanceStatus = 'active' | 'hidden' | 'invalid' | 'deleted';

/** Canonical instance signed/admitted by the Host after a complete final message. */
export interface NeoUIInstanceV1 {
  schemaVersion: typeof NEO_UI_SCHEMA_VERSION;
  instanceId: string;
  sessionId: string;
  sourceMessageId: string;
  sourceOrdinal: number;
  sourceKey: string;
  specHash: string;
  origin: 'model';
  spec: NeoUIModelSpecV1;
  state: Record<string, unknown>;
  stateRevision: number;
  status: NeoUIInstanceStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** Portable, non-authoritative snapshot used only by explicit JSON export. */
export interface NeoUIExportSnapshotV1 {
  schemaVersion: typeof NEO_UI_SCHEMA_VERSION;
  sourceMessageId: string;
  sourceOrdinal: number;
  specHash: string;
  spec: NeoUIModelSpecV1;
  state: Record<string, unknown>;
  stateRevision: number;
  status: NeoUIInstanceStatus;
  updatedAt: number;
}

export interface NeoUIEventV1 {
  eventId: string;
  sessionId: string;
  instanceId: string;
  nodeId: string;
  specHash: string;
  baseStateRevision: number;
  intent: NeoUIIntent;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: number;
}

type NeoUIEventStatus = 'applied' | 'duplicate' | 'rejected' | 'conflict';

export interface NeoUIEventResultV1 {
  status: NeoUIEventStatus;
  instance?: NeoUIInstanceV1;
  hostSurface?: NeoUIHostSurfaceV1;
  error?: string;
}

export type ExecutionManifestStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'invalidated'
  | 'orphaned'
  | 'failed';

export interface ExecutionManifestItemV1 {
  id: string;
  label: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  scopeHash: string;
  permissionBoundary?: string;
  resourceRevision?: string;
}

export interface ExecutionManifestV1 {
  schemaVersion: typeof NEO_UI_SCHEMA_VERSION;
  manifestId: string;
  sessionId: string;
  instanceId: string;
  origin: 'host';
  nonce: string;
  scopeHash: string;
  title: string;
  summary: string;
  items: ExecutionManifestItemV1[];
  status: ExecutionManifestStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  invalidationReason?: string;
}

export interface NeoUIHostSurfaceV1 {
  schemaVersion: typeof NEO_UI_SCHEMA_VERSION;
  surfaceId: string;
  origin: 'host';
  kind: 'execution_manifest';
  manifest: ExecutionManifestV1;
}

export interface NeoUIResolveInstanceRequest {
  sessionId: string;
  sourceMessageId: string;
  sourceOrdinal: number;
  rawSpec: string;
}

export interface NeoUIResolveInstanceResult {
  enabled: boolean;
  instance?: NeoUIInstanceV1;
  hostSurface?: NeoUIHostSurfaceV1;
  error?: string;
  fallback?: string;
}

export interface NeoUIApplyEventRequest {
  event: NeoUIEventV1;
}

export interface NeoUIResolveManifestRequest {
  sessionId: string;
  manifestId: string;
  nonce: string;
  decision: 'approve' | 'reject';
}

export interface NeoUIResolveManifestResult {
  manifest: ExecutionManifestV1;
  accepted: boolean;
  error?: string;
}

interface NeoUISpecParseSuccess {
  success: true;
  spec: NeoUIModelSpecV1;
}

interface NeoUISpecParseFailure {
  success: false;
  error: string;
  fallback?: string;
}

export type NeoUISpecParseResult = NeoUISpecParseSuccess | NeoUISpecParseFailure;

const COMPONENT_TYPES = new Set<string>(NEO_UI_COMPONENT_TYPES);
const MODEL_INTENTS = new Set<string>(NEO_UI_MODEL_INTENTS);
const FORBIDDEN_KEYS = new Set([
  'issuer',
  'origin',
  'instanceid',
  'manifestid',
  'nonce',
  'tool',
  'toolname',
  'command',
  'html',
  'classname',
  'style',
  'script',
  'dangerouslysetinnerhtml',
  'url',
  'href',
  'src',
  'shell',
]);
const ROOT_KEYS = new Set(['schemaVersion', 'title', 'summary', 'presentation', 'initialState', 'components', 'fallback']);
const PRESENTATION_KEYS = new Set(['width', 'disclosure', 'priority']);
const NODE_KEYS = new Set(['id', 'type', 'props', 'bindings', 'actions', 'children']);
const ACTION_KEYS = new Set(['event', 'intent', 'valuePath']);

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return FORBIDDEN_KEYS.has(normalized)
    || /^on[a-z]/.test(normalized)
    || /(?:url|href|src)$/.test(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateJsonValue(value: unknown, depth: number, path: string): string | null {
  if (depth > NEO_UI_MAX_DEPTH) return `${path} exceeds maximum depth`;
  if (typeof value === 'string') {
    return value.length <= NEO_UI_MAX_STRING_LENGTH ? null : `${path} string is too long`;
  }
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} must be finite`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonValue(value[index], depth + 1, `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (!isRecord(value)) return `${path} contains unsupported data`;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key)) return `${path}.${key} is not allowed`;
    const error = validateJsonValue(child, depth + 1, `${path}.${key}`);
    if (error) return error;
  }
  return null;
}

function validateNode(
  value: unknown,
  depth: number,
  ids: Set<string>,
  nodeCount: { value: number },
): string | null {
  if (!isRecord(value)) return 'component must be an object';
  for (const key of Object.keys(value)) {
    if (!NODE_KEYS.has(key)) return `component.${key} is not allowed`;
  }
  if (depth > NEO_UI_MAX_DEPTH) return 'component tree exceeds maximum depth';
  nodeCount.value += 1;
  if (nodeCount.value > NEO_UI_MAX_NODES) return 'component tree exceeds node budget';

  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) {
    return 'component id is invalid';
  }
  if (ids.has(value.id)) return `duplicate component id: ${value.id}`;
  ids.add(value.id);
  if (typeof value.type !== 'string' || !COMPONENT_TYPES.has(value.type)) {
    return `unsupported component type: ${String(value.type)}`;
  }

  if (value.props !== undefined) {
    if (!isRecord(value.props)) return `${value.id}.props must be an object`;
    const error = validateJsonValue(value.props, depth + 1, `${value.id}.props`);
    if (error) return error;
  }
  if (value.bindings !== undefined) {
    if (!isRecord(value.bindings)) return `${value.id}.bindings must be an object`;
    for (const binding of Object.values(value.bindings)) {
      if (typeof binding !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(binding)) {
        return `${value.id}.bindings contains an invalid state path`;
      }
    }
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) return `${value.id}.actions must be an array`;
    for (const action of value.actions) {
      if (!isRecord(action) || typeof action.event !== 'string' || typeof action.intent !== 'string') {
        return `${value.id}.actions contains an invalid action`;
      }
      for (const key of Object.keys(action)) {
        if (!ACTION_KEYS.has(key)) return `${value.id}.actions.${key} is not allowed`;
      }
      if (!['change', 'submit', 'activate', 'approve', 'reject'].includes(action.event)) {
        return `${value.id}.actions contains an unsupported event`;
      }
      if (!MODEL_INTENTS.has(action.intent)) {
        return `${value.id}.actions contains an unsupported intent`;
      }
      if (action.valuePath !== undefined && (
        typeof action.valuePath !== 'string'
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(action.valuePath)
      )) {
        return `${value.id}.actions contains an invalid value path`;
      }
    }
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return `${value.id}.children must be an array`;
    for (const child of value.children) {
      const error = validateNode(child, depth + 1, ids, nodeCount);
      if (error) return error;
    }
  }
  return null;
}

function readFallback(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.fallback !== 'string') return undefined;
  const fallback = value.fallback.trim();
  return fallback.length > 0 ? fallback.slice(0, 4_000) : undefined;
}

export function parseNeoUIModelSpec(raw: string): NeoUISpecParseResult {
  if (byteLength(raw) > NEO_UI_MAX_SPEC_BYTES) {
    return { success: false, error: 'neo_ui spec exceeds 64 KiB' };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { success: false, error: 'neo_ui spec is not valid JSON' };
  }

  const fallback = readFallback(value);
  if (!isRecord(value)) return { success: false, error: 'neo_ui spec must be an object', fallback };
  for (const key of Object.keys(value)) {
    if (!ROOT_KEYS.has(key)) return { success: false, error: `${key} is not allowed`, fallback };
    if (isForbiddenKey(key)) return { success: false, error: `${key} is Host-owned`, fallback };
  }
  if (value.schemaVersion !== NEO_UI_SCHEMA_VERSION) {
    return { success: false, error: `unsupported neo_ui schemaVersion: ${String(value.schemaVersion)}`, fallback };
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    return { success: false, error: 'neo_ui components must be a non-empty array', fallback };
  }
  if (!fallback) return { success: false, error: 'neo_ui fallback is required' };

  if (value.initialState !== undefined) {
    if (!isRecord(value.initialState)) {
      return { success: false, error: 'neo_ui initialState must be an object', fallback };
    }
    const serializedState = JSON.stringify(value.initialState);
    if (byteLength(serializedState) > NEO_UI_MAX_STATE_BYTES) {
      return { success: false, error: 'neo_ui initialState exceeds 16 KiB', fallback };
    }
    const stateError = validateJsonValue(value.initialState, 1, 'initialState');
    if (stateError) return { success: false, error: stateError, fallback };
  }

  if (value.presentation !== undefined) {
    if (!isRecord(value.presentation)) {
      return { success: false, error: 'neo_ui presentation must be an object', fallback };
    }
    for (const key of Object.keys(value.presentation)) {
      if (!PRESENTATION_KEYS.has(key)) {
        return { success: false, error: `neo_ui presentation.${key} is not allowed`, fallback };
      }
    }
    if (value.presentation.width !== undefined && !['full', 'summary'].includes(String(value.presentation.width))) {
      return { success: false, error: 'neo_ui presentation.width is invalid', fallback };
    }
    if (value.presentation.disclosure !== undefined && !['expanded', 'collapsed', 'focus'].includes(String(value.presentation.disclosure))) {
      return { success: false, error: 'neo_ui presentation.disclosure is invalid', fallback };
    }
    if (value.presentation.priority !== undefined && !['primary', 'supporting'].includes(String(value.presentation.priority))) {
      return { success: false, error: 'neo_ui presentation.priority is invalid', fallback };
    }
  }

  const ids = new Set<string>();
  const nodeCount = { value: 0 };
  for (const node of value.components) {
    const error = validateNode(node, 1, ids, nodeCount);
    if (error) return { success: false, error, fallback };
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    return { success: false, error: 'neo_ui title must be a string', fallback };
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    return { success: false, error: 'neo_ui summary must be a string', fallback };
  }

  return { success: true, spec: value as unknown as NeoUIModelSpecV1 };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function canonicalizeNeoUISpec(spec: NeoUIModelSpecV1): string {
  return JSON.stringify(stableValue(spec));
}

export function extractNeoUIRawSpecs(content: string): Array<{ rawSpec: string; sourceOrdinal: number }> {
  const specs: Array<{ rawSpec: string; sourceOrdinal: number }> = [];
  const regex = /```neo_ui\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let sourceOrdinal = 0;
  while ((match = regex.exec(content)) !== null) {
    specs.push({ rawSpec: match[1].trim(), sourceOrdinal });
    sourceOrdinal += 1;
  }
  return specs;
}

// ---------------------------------------------------------------------------
// HTML 产物人工编辑的持久化（S5 P3）——与 neo_ui 声明式实例是两套东西
// ---------------------------------------------------------------------------

export interface GenerativeUiEditPersistRequest {
  sessionId: string;
  messageId: string;
  /** 消息里第几个 generative_ui fence（与渲染侧 ordinal 同源） */
  sourceOrdinal: number;
  /** 用户开始编辑时那份正文的哈希，用来和库里当前值对账 */
  baseHash: string;
  /** 改完的 HTML 正文（不含编辑标记，host 会自己贴新鲜的） */
  newCode: string;
  /** 这次动过的属性，仅供模型参考 */
  fields: string[];
}

export type GenerativeUiEditPersistReason =
  | 'conflict'
  | 'ordinal_out_of_range'
  | 'message_not_found';

export interface GenerativeUiEditPersistResult {
  persisted: boolean;
  reason?: GenerativeUiEditPersistReason;
}
