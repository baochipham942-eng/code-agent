import type {
  AgentEngineCapability,
  AgentEngineKind,
  AgentEnginePermissionProfile,
  AgentEngineReliability,
  AgentEngineRiskTier,
  ExternalAgentEngineKind,
} from './contract/agentEngine';

export type ExternalEngineModelSelection =
  | 'neo_provider'
  | 'runtime_catalog'
  | 'client_default'
  | 'unavailable';

type ExternalEngineTransport = 'native' | 'cli' | 'local_http_sse' | 'acp';

interface ExternalEngineAdapterContract {
  /** Stable adapter registry key. A manifest cannot become executable without this adapter. */
  adapterId?: string;
  transport: ExternalEngineTransport;
  promptTransport: 'internal' | 'stdin' | 'argv' | 'http_body';
  eventFormat: 'internal' | 'stream_json' | 'jsonl' | 'sse' | 'unknown';
  credentialOwner: 'neo' | 'official_client';
  evidence: 'production' | 'local_spike' | 'official_docs' | 'none';
}

interface ExternalEngineProbeContract {
  commands: string[];
  /** Absolute or home-relative product-bundled CLI paths tried before PATH lookup. */
  binaryPaths?: string[];
  versionArgs: string[];
  /** Slow official clients may override the conservative registry default. */
  timeoutMs?: number;
  modelDiscovery?: {
    args: string[];
    parser: 'supported_models_parenthesized' | 'model_map_json' | 'grok_models_text';
    /** Text marker used by supported_models_parenthesized. */
    marker?: string;
    /** Object key containing an id-keyed model map for model_map_json. */
    modelMapKey?: string;
    /** Optional display-label field on each model-map entry. */
    labelField?: string;
    /** Optional side-effect-free probe for the client's configured default model. */
    defaultModelProbe?: {
      args: string[];
      pattern: string;
    };
    preferredDefault?: string;
    merge: 'replace' | 'overlay';
  };
  authProbe?: {
    args: string[];
    successPattern: string;
    /** Optional explicit negative marker checked before the success marker. */
    failurePattern?: string;
  };
  /**
   * Official-client-owned state marker used only when the CLI exposes no
   * side-effect-free auth-status command. Neo checks existence, never contents.
   */
  authStateMarker?: string;
}

export interface ExternalEngineManifest {
  id: string;
  kind?: AgentEngineKind;
  label: string;
  summary: string;
  commandSummary?: string;
  iconAsset?: string;
  /** 本机 .app 候选名（darwin）：host 探测时从已安装 app 提取真图标，未装回退首字母瓦片 */
  macAppNames?: readonly string[];
  probe?: ExternalEngineProbeContract;
  adapter: ExternalEngineAdapterContract;
  modelSelection: ExternalEngineModelSelection;
  capabilities: AgentEngineCapability[];
  defaultPermissionProfile: AgentEnginePermissionProfile;
  riskTier: AgentEngineRiskTier;
  reliability: Omit<AgentEngineReliability, 'cliStatus' | 'authState' | 'quotaState'>;
  auditNotes: string[];
  recommendation?: {
    label: string;
    reason: string;
  };
}

const EXTERNAL_ENGINE_MANIFESTS: readonly ExternalEngineManifest[] = [
  {
    id: 'native',
    kind: 'native',
    label: 'Neo',
    summary: 'Neo 原生执行引擎，使用现有 Provider、工具、权限、Trace 与 Review。',
    iconAsset: '/code-agent/agent-neo-mark.svg',
    adapter: {
      adapterId: 'native',
      transport: 'native',
      promptTransport: 'internal',
      eventFormat: 'internal',
      credentialOwner: 'neo',
      evidence: 'production',
    },
    modelSelection: 'neo_provider',
    capabilities: ['execute', 'stream_events', 'resume', 'review'],
    defaultPermissionProfile: 'default',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'workspace_tools',
      transcriptMode: 'clean_stream_json',
    },
    auditNotes: ['Uses the existing model provider and permission stack.'],
  },
  {
    id: 'codex_cli',
    kind: 'codex_cli',
    label: 'Codex CLI',
    summary: '复用本机 Codex 登录态，在受控工作区中执行并归一化事件流。',
    commandSummary: 'codex exec --json',
    probe: {
      commands: ['codex'],
      versionArgs: ['--version'],
      authProbe: {
        args: ['login', 'status'],
        successPattern: 'Logged in',
      },
    },
    adapter: {
      adapterId: 'codex_cli',
      transport: 'cli',
      promptTransport: 'stdin',
      eventFormat: 'stream_json',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'runtime_catalog',
    capabilities: ['execute', 'stream_events', 'review'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'workspace_tools',
      transcriptMode: 'clean_stream_json',
      partialMessages: false,
      mcpBridge: false,
    },
    auditNotes: [
      'Registry probes installation only; the official CLI owns credentials.',
      'The adapter never copies or persists the official login credential.',
    ],
  },
  {
    id: 'claude_code',
    macAppNames: ['Claude.app'],
    kind: 'claude_code',
    label: 'Claude Code',
    summary: '复用本机 Claude Code 登录态，以只读工具和流式事件执行。',
    commandSummary: 'claude -p --output-format stream-json --permission-mode plan',
    probe: {
      commands: ['claude'],
      versionArgs: ['--version'],
      authProbe: {
        args: ['auth', 'status'],
        successPattern: '"loggedIn": true',
      },
    },
    adapter: {
      adapterId: 'claude_code',
      transport: 'cli',
      promptTransport: 'stdin',
      eventFormat: 'stream_json',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'runtime_catalog',
    capabilities: ['execute', 'stream_events', 'review'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'read_only_cli_tools',
      transcriptMode: 'clean_stream_json',
      partialMessages: true,
      mcpBridge: false,
    },
    auditNotes: [
      'The adapter uses non-interactive plan mode with a bounded read-only tool allowlist.',
      'The official CLI owns credentials; Neo never injects an API key.',
    ],
  },
  {
    id: 'mimo_code',
    kind: 'mimo_code',
    label: 'MiMo-Code',
    summary: '复用本机 MiMo-Code 登录态，通过受控 JSON 事件流执行。',
    commandSummary: 'mimo run --format json',
    probe: { commands: ['mimo'], versionArgs: ['--version'] },
    adapter: {
      adapterId: 'mimo_code',
      transport: 'cli',
      promptTransport: 'argv',
      eventFormat: 'jsonl',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'client_default',
    capabilities: ['execute', 'stream_events', 'review'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'json',
      toolSupport: 'workspace_tools',
      transcriptMode: 'clean_stream_json',
      partialMessages: false,
      mcpBridge: false,
    },
    auditNotes: [
      'Credentials are read by the official CLI from MIMO_HOME.',
      'Neo does not claim a model catalog that the client did not return.',
    ],
  },
  {
    id: 'kimi_code',
    macAppNames: ['Kimi.app'],
    kind: 'kimi_code',
    label: 'Kimi Code',
    summary: '复用本机 Kimi Code 登录态，通过归一化 stream-json 执行。',
    commandSummary: 'kimi -p --output-format stream-json',
    probe: {
      commands: ['kimi'],
      versionArgs: ['--version'],
      authProbe: {
        args: ['provider', 'list', '--json'],
        successPattern: '"managed:kimi-code"',
      },
      modelDiscovery: {
        args: ['provider', 'list', '--json'],
        parser: 'model_map_json',
        modelMapKey: 'models',
        labelField: 'displayName',
        defaultModelProbe: {
          args: ['provider', 'list'],
          pattern: 'Default model:\\s*([^\\s]+)',
        },
        merge: 'replace',
      },
    },
    adapter: {
      adapterId: 'kimi_code',
      transport: 'cli',
      promptTransport: 'argv',
      eventFormat: 'stream_json',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'runtime_catalog',
    capabilities: ['execute', 'stream_events', 'review'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'workspace_tools',
      transcriptMode: 'clean_stream_json',
      partialMessages: false,
      mcpBridge: false,
    },
    auditNotes: [
      'Credentials remain under KIMI_CODE_HOME and are managed by kimi login.',
      'Neo reads only the side-effect-free provider/model catalog returned by the official CLI.',
      'Provider/model discovery never reads, copies, displays, or persists official credentials.',
    ],
  },
  {
    id: 'codebuddy_code',
    macAppNames: ['WorkBuddy.app', 'CodeBuddy.app'],
    kind: 'codebuddy_code',
    label: 'WorkBuddy',
    summary: '复用本机 WorkBuddy / CodeBuddy 官方账号，以禁用工具的流式会话执行。',
    commandSummary: 'codebuddy -p --output-format stream-json --permission-mode plan --tools ""',
    probe: {
      commands: ['codebuddy', 'cbc'],
      binaryPaths: [
        '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
        '~/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
      ],
      versionArgs: ['--version'],
      authStateMarker: '~/.workbuddy/user-state.json',
    },
    adapter: {
      adapterId: 'codebuddy_code',
      transport: 'cli',
      promptTransport: 'argv',
      eventFormat: 'stream_json',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'client_default',
    capabilities: ['execute', 'stream_events'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'none',
      transcriptMode: 'clean_stream_json',
      partialMessages: true,
      mcpBridge: false,
    },
    auditNotes: [
      'The local spike proved argv prompt transport, stream-json output, model selection, and official-client login reuse.',
      'Neo forces plan mode, disables all built-in tools, and never reads or persists WorkBuddy credentials.',
      'The auth marker probe checks only official-client state-file existence; runtime authentication still fails closed.',
    ],
  },
  {
    id: 'grok_cli',
    kind: 'grok_cli',
    label: 'Grok Build',
    summary: '复用本机 Grok 官方登录态，以禁用工具和联网搜索的流式会话执行。',
    commandSummary: 'grok -p --output-format streaming-json --permission-mode plan --tools ""',
    probe: {
      commands: ['grok'],
      binaryPaths: ['~/.local/bin/grok', '~/.grok/bin/grok'],
      versionArgs: ['--version'],
      timeoutMs: 12_000,
      authProbe: {
        args: ['models'],
        successPattern: 'You are logged in with grok.com.',
        failurePattern: 'not logged in',
      },
      modelDiscovery: {
        args: ['models'],
        parser: 'grok_models_text',
        defaultModelProbe: {
          args: ['models'],
          pattern: 'Default model:\\s*([^\\s]+)',
        },
        merge: 'replace',
      },
    },
    adapter: {
      adapterId: 'grok_cli',
      transport: 'cli',
      promptTransport: 'argv',
      eventFormat: 'jsonl',
      credentialOwner: 'official_client',
      evidence: 'production',
    },
    modelSelection: 'runtime_catalog',
    capabilities: ['execute', 'stream_events', 'review'],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'stream_json',
      toolSupport: 'none',
      transcriptMode: 'clean_stream_json',
      partialMessages: true,
      mcpBridge: false,
    },
    auditNotes: [
      'The official Grok Build CLI owns OAuth credentials; Neo never reads or persists them.',
      'The local spike proved official-account login, model discovery, streaming-json text events, and terminal session identity.',
      'Neo disables built-in tools, subagents, memory, and web search for the initial read-only integration.',
    ],
  },
  {
    id: 'qoder_work',
    macAppNames: ['Qoder.app'],
    label: 'Qoder Work',
    summary: '已检测本机 Qoder Work CLI；当前 CLI 尚未登录，执行与模型能力保持关闭。',
    commandSummary: 'qoderclicn -p -o stream-json --permission-mode dont_ask --tools ""',
    probe: {
      commands: ['qoderclicn'],
      binaryPaths: [
        '/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn',
        '~/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn',
      ],
      versionArgs: ['--version'],
      authProbe: {
        args: ['status'],
        successPattern: 'Account:',
        failurePattern: 'Not logged in',
      },
    },
    adapter: {
      transport: 'cli',
      promptTransport: 'argv',
      eventFormat: 'stream_json',
      credentialOwner: 'official_client',
      evidence: 'local_spike',
    },
    modelSelection: 'unavailable',
    capabilities: [],
    defaultPermissionProfile: 'read_only',
    riskTier: 'medium',
    reliability: {
      streamingMode: 'unknown',
      toolSupport: 'unknown',
      transcriptMode: 'unknown',
      partialMessages: false,
      mcpBridge: false,
    },
    auditNotes: [
      'The installed Qoder Work 1.0.47 CLI exposes print mode, stream-json, workspace, tool restriction, and model-list flags.',
      'The real execution probe failed closed because the official CLI reported that it was not logged in.',
      'Neo does not read, copy, display, or persist Qoder Work credentials.',
    ],
    recommendation: {
      label: '需要登录',
      reason: '请先在 Qoder Work CLI 完成官方登录，再验证模型目录和真实事件流。',
    },
  },
  {
    id: 'comate_zulu',
    macAppNames: ['Comate.app'],
    label: 'Comate / Zulu',
    summary: '已发现本机 CLI/HTTP/SSE 能力证据；生产 Adapter 尚未开放。',
    commandSummary: 'zulu run / zulu serve',
    probe: { commands: ['zulu'], versionArgs: ['--version'] },
    adapter: {
      transport: 'local_http_sse',
      promptTransport: 'http_body',
      eventFormat: 'sse',
      credentialOwner: 'official_client',
      evidence: 'local_spike',
    },
    modelSelection: 'runtime_catalog',
    capabilities: [],
    defaultPermissionProfile: 'read_only',
    riskTier: 'high',
    reliability: {
      streamingMode: 'unknown',
      toolSupport: 'unknown',
      transcriptMode: 'unknown',
    },
    auditNotes: [
      'The local spike proved discovery, login status, models, JSONL, conversation continuation, cancellation, and local HTTP/SSE.',
      'Execution remains blocked until private event mapping, prompt exposure, tool denial, persistence, and loopback checks are enforced.',
    ],
    recommendation: {
      label: '可探测',
      reason: '适合后续通过通用 Manifest + Zulu codec 接入。',
    },
  },
  {
    id: 'cursor_cli',
    macAppNames: ['Cursor.app'],
    label: 'Cursor CLI',
    summary: '推荐项；尚无本仓实机协议证据，不会伪装成可执行引擎。',
    adapter: {
      transport: 'cli',
      promptTransport: 'stdin',
      eventFormat: 'unknown',
      credentialOwner: 'official_client',
      evidence: 'none',
    },
    modelSelection: 'unavailable',
    capabilities: [],
    defaultPermissionProfile: 'read_only',
    riskTier: 'high',
    reliability: {
      streamingMode: 'unknown',
      toolSupport: 'unknown',
      transcriptMode: 'unknown',
    },
    auditNotes: ['No executable probe or adapter is enabled without repository evidence.'],
    recommendation: {
      label: '推荐了解',
      reason: '需要完成官方协议与实机验证后才能在 Neo 中选择。',
    },
  },
] as const;

export function listExternalEngineManifests(): readonly ExternalEngineManifest[] {
  return EXTERNAL_ENGINE_MANIFESTS;
}

export function getExternalEngineManifestForKind(
  kind: AgentEngineKind,
): ExternalEngineManifest | undefined {
  return EXTERNAL_ENGINE_MANIFESTS.find((manifest) => manifest.kind === kind);
}

export function isManifestBackedExternalKind(
  kind: AgentEngineKind,
): kind is ExternalAgentEngineKind {
  return kind !== 'native' && Boolean(getExternalEngineManifestForKind(kind)?.adapter.adapterId);
}
