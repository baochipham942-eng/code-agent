import type { ModelConfig } from '../../shared/contract/model';
import type { InferenceOptions, ModelMessage } from './types';

export const PROVIDER_RUNTIME_CAPABILITY_STATUSES = [
  'supported',
  'experimental',
  'unknown',
  'unsupported',
] as const;

export type ProviderRuntimeCapabilityStatus = typeof PROVIDER_RUNTIME_CAPABILITY_STATUSES[number];

export const PROVIDER_RUNTIME_IDS = [
  'native',
  'codex_cli',
  'claude_code',
  'mimo_code',
  'kimi_code',
] as const;

export type ProviderRuntimeId = typeof PROVIDER_RUNTIME_IDS[number];

export const PROVIDER_PROTOCOL_FAMILIES = [
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
  'openai_compatible_gateway',
  'ollama_litellm_local',
  'google_generative_language',
  'opaque_cli',
] as const;

export type ProviderProtocolFamily = typeof PROVIDER_PROTOCOL_FAMILIES[number];

export const PROVIDER_RUNTIME_CAPABILITIES = [
  'text_streaming',
  'reasoning_effort',
  'tool_choice_auto',
  'tool_choice_none',
  'tool_choice_required',
  'tool_choice_named',
  'image_input',
  'pdf_file_input',
  'streaming_tool_call_arguments',
  'usage_context_window_trust',
  'stop_abort',
  'connect_timeout',
  'first_token_timeout',
  'stream_idle_timeout',
  'upstream_error_classification',
] as const;

export type ProviderRuntimeCapability = typeof PROVIDER_RUNTIME_CAPABILITIES[number];

export interface ProviderRuntimeCapabilityEvidence {
  requestFixture: string;
  automatedTest: string;
  liveSmokeLedgerId: string;
}

export interface ProviderRuntimeCapabilityCell {
  status: ProviderRuntimeCapabilityStatus;
  note: string;
  evidence?: ProviderRuntimeCapabilityEvidence;
}

export interface ProviderRuntimeCapabilityEntry {
  runtime: ProviderRuntimeId;
  protocolFamily: ProviderProtocolFamily;
  providerScope: readonly string[];
  adapterBoundary: string;
  capabilities: Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell>;
  capabilityOverrides?: Readonly<Record<string, Partial<Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell>>>>;
}

const FIXTURE_ROOT = 'docs/capabilities/request-shapes';
const MATRIX_TEST = 'tests/unit/model/providerRuntimeCapabilities.test.ts';
const LIVE_LEDGER = 'docs/capabilities/provider-runtime-live-smoke-ledger.json';

function cell(
  status: ProviderRuntimeCapabilityStatus,
  note: string,
  evidence?: ProviderRuntimeCapabilityEvidence,
): ProviderRuntimeCapabilityCell {
  return { status, note, ...(evidence ? { evidence } : {}) };
}

function evidence(fixture: string, ledgerId: string): ProviderRuntimeCapabilityEvidence {
  return {
    requestFixture: `${FIXTURE_ROOT}/${fixture}`,
    automatedTest: MATRIX_TEST,
    liveSmokeLedgerId: `${LIVE_LEDGER}#${ledgerId}`,
  };
}

function nativeCapabilities(
  fixture: string,
  ledgerId: string,
  overrides: Partial<Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell>> = {},
): Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell> {
  const proof = evidence(fixture, ledgerId);
  const experimental = (note: string) => cell('experimental', note, proof);
  return {
    text_streaming: experimental('AI SDK streamText is covered automatically; live provider verification is pending.'),
    reasoning_effort: cell('unknown', 'This protocol group has no common normalized reasoning-effort request shape.'),
    tool_choice_auto: experimental('AI SDK request shaping is covered; live provider verification is pending.'),
    tool_choice_none: experimental('AI SDK request shaping is covered; live provider verification is pending.'),
    tool_choice_required: experimental('AI SDK request shaping is covered; live provider verification is pending.'),
    tool_choice_named: experimental('AI SDK named-tool request shaping is covered; live provider verification is pending.'),
    image_input: experimental('Base64 image conversion is covered; live provider/model verification is pending.'),
    pdf_file_input: cell('unsupported', 'Native ModelMessage has no file/PDF part at this adapter boundary.'),
    streaming_tool_call_arguments: experimental('AI SDK tool-input delta accumulation is covered; live provider verification is pending.'),
    usage_context_window_trust: experimental('Provider usage is normalized, but context-window truth is registry/model dependent.'),
    stop_abort: experimental('AbortSignal is wired through the SDK and transport; provider-side live verification is pending.'),
    connect_timeout: cell('unsupported', 'The adapter has a whole-request watchdog, not a distinct connect timeout.'),
    first_token_timeout: experimental('The first-byte watchdog is covered by deterministic tests.'),
    stream_idle_timeout: experimental('The stream inactivity watchdog is covered by deterministic tests.'),
    upstream_error_classification: experimental('Retry and user-facing classification are covered; live provider taxonomy is pending.'),
    ...overrides,
  };
}

function opaqueCliCapabilities(
  fixture: string,
  ledgerId: string,
): Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell> {
  const proof = evidence(fixture, ledgerId);
  return {
    text_streaming: cell('experimental', 'The CLI JSON/JSONL event parser is covered; authenticated live smoke is pending.', proof),
    reasoning_effort: cell('unknown', 'Neo does not send a normalized reasoning/effort control to this CLI.'),
    tool_choice_auto: cell('unsupported', 'Tool policy is owned by the external CLI, not Neo tool_choice.'),
    tool_choice_none: cell('unsupported', 'Tool policy is owned by the external CLI, not Neo tool_choice.'),
    tool_choice_required: cell('unsupported', 'Tool policy is owned by the external CLI, not Neo tool_choice.'),
    tool_choice_named: cell('unsupported', 'Tool policy is owned by the external CLI, not Neo tool_choice.'),
    image_input: cell('unsupported', 'The current external runtime contract rejects attachments before spawn.'),
    pdf_file_input: cell('unsupported', 'The current external runtime contract rejects attachments before spawn.'),
    streaming_tool_call_arguments: cell('unsupported', 'The normalized external event stream exposes tool names, not argument deltas.'),
    usage_context_window_trust: cell('unsupported', 'The current external runtime result does not expose normalized trusted usage.'),
    stop_abort: cell('unsupported', 'The current external runtime request has no Run-scoped abort signal.'),
    connect_timeout: cell('unsupported', 'The adapter has a total process timeout, not a distinct connect timeout.'),
    first_token_timeout: cell('unsupported', 'The adapter emits a stall warning but has no first-token abort deadline.'),
    stream_idle_timeout: cell('unsupported', 'The adapter has a total process timeout but no stream-idle abort deadline.'),
    upstream_error_classification: cell('experimental', 'Auth/quota/network/timeout classification is covered; live CLI verification is pending.', proof),
  };
}

export const PROVIDER_RUNTIME_CAPABILITY_MATRIX: readonly ProviderRuntimeCapabilityEntry[] = [
  {
    runtime: 'native',
    protocolFamily: 'anthropic_messages',
    providerScope: ['claude', 'anthropic'],
    adapterBoundary: '@ai-sdk/anthropic createAnthropic -> generateText/streamText',
    capabilities: nativeCapabilities('native-anthropic-messages.json', 'native-anthropic-pending'),
  },
  {
    runtime: 'native',
    protocolFamily: 'openai_chat_completions',
    providerScope: ['openai'],
    adapterBoundary: '@ai-sdk/openai-compatible -> /chat/completions',
    capabilities: nativeCapabilities('native-openai-chat-completions.json', 'native-openai-chat-pending'),
  },
  {
    runtime: 'native',
    protocolFamily: 'openai_responses',
    providerScope: [],
    adapterBoundary: 'no production adapter',
    capabilities: Object.fromEntries(PROVIDER_RUNTIME_CAPABILITIES.map((capability) => [
      capability,
      cell('unsupported', 'Neo has no production OpenAI Responses adapter.'),
    ])) as Record<ProviderRuntimeCapability, ProviderRuntimeCapabilityCell>,
  },
  {
    runtime: 'native',
    protocolFamily: 'openai_compatible_gateway',
    providerScope: ['deepseek', 'groq', 'zhipu', 'qwen', 'moonshot', 'minimax', 'perplexity', 'volcengine', 'longcat', 'xiaomi', 'openrouter', 'grok', 'custom'],
    adapterBoundary: '@ai-sdk/openai-compatible with provider-specific body transform',
    capabilities: nativeCapabilities('native-openai-compatible-gateway.json', 'native-gateway-pending'),
    capabilityOverrides: {
      xiaomi: {
        reasoning_effort: cell(
          'experimental',
          'The Xiaomi request transform maps reasoning controls to thinking.enabled/disabled; live verification is pending.',
          evidence('native-openai-compatible-gateway.json', 'native-gateway-pending'),
        ),
      },
    },
  },
  {
    runtime: 'native',
    protocolFamily: 'ollama_litellm_local',
    providerScope: ['local'],
    adapterBoundary: '@ai-sdk/openai-compatible -> configured local endpoint',
    capabilities: nativeCapabilities('native-ollama-litellm-local.json', 'native-local-pending', {
      reasoning_effort: cell('unknown', 'Local endpoints do not share a normalized reasoning-effort contract.'),
      tool_choice_none: cell('unknown', 'Local endpoint tool_choice support depends on the server and model.'),
      tool_choice_required: cell('unknown', 'Local endpoint tool_choice support depends on the server and model.'),
      tool_choice_named: cell('unknown', 'Local endpoint tool_choice support depends on the server and model.'),
      image_input: cell('unknown', 'Local endpoint image support depends on the server and model.'),
      usage_context_window_trust: cell('unknown', 'Local endpoint usage and context-window metadata are not normalized as trusted.'),
    }),
  },
  {
    runtime: 'native',
    protocolFamily: 'google_generative_language',
    providerScope: ['gemini'],
    adapterBoundary: '@ai-sdk/google createGoogleGenerativeAI -> generateText/streamText',
    capabilities: nativeCapabilities('native-google-generative-language.json', 'native-google-pending'),
  },
  {
    runtime: 'codex_cli',
    protocolFamily: 'opaque_cli',
    providerScope: ['cli-owned'],
    adapterBoundary: 'codex exec --json',
    capabilities: opaqueCliCapabilities('runtime-codex-cli.json', 'codex-cli-pending'),
  },
  {
    runtime: 'claude_code',
    protocolFamily: 'opaque_cli',
    providerScope: ['cli-owned'],
    adapterBoundary: 'claude -p --output-format stream-json',
    capabilities: opaqueCliCapabilities('runtime-claude-code.json', 'claude-code-pending'),
  },
  {
    runtime: 'mimo_code',
    protocolFamily: 'opaque_cli',
    providerScope: ['cli-owned'],
    adapterBoundary: 'mimo run --format json',
    capabilities: opaqueCliCapabilities('runtime-mimo-code.json', 'mimo-code-pending'),
  },
  {
    runtime: 'kimi_code',
    protocolFamily: 'opaque_cli',
    providerScope: ['cli-owned'],
    adapterBoundary: 'kimi -p --output-format stream-json',
    capabilities: opaqueCliCapabilities('runtime-kimi-code.json', 'kimi-code-pending'),
  },
] as const;

export class ProviderRuntimeCapabilityError extends Error {
  readonly code = 'PROVIDER_RUNTIME_CAPABILITY_BLOCKED';

  constructor(
    readonly runtime: ProviderRuntimeId,
    readonly protocolFamily: ProviderProtocolFamily,
    readonly capability: ProviderRuntimeCapability,
    readonly status: 'unknown' | 'unsupported',
  ) {
    super(`Capability ${capability} is ${status} for ${runtime}/${protocolFamily}`);
    this.name = 'ProviderRuntimeCapabilityError';
  }
}

export function resolveNativeProtocolFamily(config: ModelConfig): ProviderProtocolFamily {
  if (config.provider === 'claude' || config.provider === 'anthropic') {
    return 'anthropic_messages';
  }
  if (config.provider === 'local') return 'ollama_litellm_local';
  if (config.provider === 'gemini') return 'google_generative_language';
  if (config.provider === 'openai') return 'openai_chat_completions';
  return 'openai_compatible_gateway';
}

export function getProviderRuntimeCapabilityEntry(
  runtime: ProviderRuntimeId,
  protocolFamily: ProviderProtocolFamily,
): ProviderRuntimeCapabilityEntry {
  const entry = PROVIDER_RUNTIME_CAPABILITY_MATRIX.find(
    (candidate) => candidate.runtime === runtime && candidate.protocolFamily === protocolFamily,
  );
  if (!entry) throw new Error(`Missing provider/runtime matrix entry for ${runtime}/${protocolFamily}`);
  return entry;
}

export function assertProviderRuntimeCapability(
  runtime: ProviderRuntimeId,
  protocolFamily: ProviderProtocolFamily,
  capability: ProviderRuntimeCapability,
  provider?: string,
): void {
  const entry = getProviderRuntimeCapabilityEntry(runtime, protocolFamily);
  const status = (provider ? entry.capabilityOverrides?.[provider]?.[capability] : undefined)?.status
    ?? entry.capabilities[capability].status;
  if (status === 'unknown' || status === 'unsupported') {
    throw new ProviderRuntimeCapabilityError(runtime, protocolFamily, capability, status);
  }
}

function hasImageInput(messages: ModelMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part.type === 'image'));
}

export function collectNativeRequestCapabilities(
  messages: ModelMessage[],
  toolsPresent: boolean,
  config: ModelConfig,
  streaming: boolean,
  signal: AbortSignal | undefined,
  options: InferenceOptions | undefined,
): ProviderRuntimeCapability[] {
  const requested = new Set<ProviderRuntimeCapability>();
  if (streaming) {
    requested.add('text_streaming');
    requested.add('first_token_timeout');
    requested.add('stream_idle_timeout');
  }
  if (
    config.provider === 'xiaomi'
    && (config.reasoningEffort || config.thinkingBudget || options?.reasoningEffort)
  ) requested.add('reasoning_effort');
  if (toolsPresent) {
    const toolChoice = options?.toolChoice ?? 'auto';
    requested.add(toolChoice === 'auto'
      ? 'tool_choice_auto'
      : toolChoice === 'none'
        ? 'tool_choice_none'
        : toolChoice === 'required'
          ? 'tool_choice_required'
          : 'tool_choice_named');
  }
  if (hasImageInput(messages)) requested.add('image_input');
  if (signal) requested.add('stop_abort');
  return [...requested];
}

export function assertNativeRequestCapabilities(
  messages: ModelMessage[],
  toolsPresent: boolean,
  config: ModelConfig,
  streaming: boolean,
  signal: AbortSignal | undefined,
  options: InferenceOptions | undefined,
): void {
  const protocolFamily = resolveNativeProtocolFamily(config);
  for (const capability of collectNativeRequestCapabilities(
    messages,
    toolsPresent,
    config,
    streaming,
    signal,
    options,
  )) {
    assertProviderRuntimeCapability('native', protocolFamily, capability, config.provider);
  }
}

export function assertExternalRuntimeAttachments(
  runtime: Exclude<ProviderRuntimeId, 'native'>,
  attachmentsCount: number | undefined,
  label: string,
): void {
  if (!attachmentsCount || attachmentsCount <= 0) return;
  try {
    assertProviderRuntimeCapability(runtime, 'opaque_cli', 'pdf_file_input');
  } catch (error) {
    if (error instanceof ProviderRuntimeCapabilityError) {
      throw new Error(`${label} engine only supports text prompts.`, { cause: error });
    }
    throw error;
  }
}

export function validateSupportedCapabilityEvidence(): string[] {
  const errors: string[] = [];
  for (const entry of PROVIDER_RUNTIME_CAPABILITY_MATRIX) {
    for (const capability of PROVIDER_RUNTIME_CAPABILITIES) {
      const cellValue = entry.capabilities[capability];
      if (cellValue.status === 'supported' && !cellValue.evidence) {
        errors.push(`${entry.runtime}/${entry.protocolFamily}/${capability} lacks three-layer evidence`);
      }
    }
    for (const [provider, overrides] of Object.entries(entry.capabilityOverrides ?? {})) {
      for (const [capability, cellValue] of Object.entries(overrides)) {
        if (cellValue?.status === 'supported' && !cellValue.evidence) {
          errors.push(`${entry.runtime}/${entry.protocolFamily}/${provider}/${capability} lacks three-layer evidence`);
        }
      }
    }
  }
  return errors;
}
