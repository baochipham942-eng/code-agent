// ============================================================================
// Agent Engine Registry
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AgentEngineDescriptor,
  AgentEngineKind,
  AgentEngineRuntimeState,
} from '../../../shared/contract/agentEngine';
import { AGENT_ENGINE_LABELS } from '../../../shared/contract/agentEngine';
import { getShellPath } from '../infra/shellEnvironment';

const execFileAsync = promisify(execFile);

interface CommandProbe {
  command: string;
  binaryPath?: string;
  version?: string;
  error?: string;
}

interface ExecProbeResult {
  stdout: string;
  stderr: string;
}

const VERSION_TIMEOUT_MS = 3000;
/**
 * 探测结果缓存 TTL。原实现每次 list() 都重跑 which + --version（每引擎最多 3s 超时），
 * 模型切换器一次交互内的多次 list() 会叠加卡顿。短 TTL 去重一次交互的重复探测，
 * 又把"装好引擎后看不到"的窗口控制在数秒内（如需立即刷新可调 invalidate()）。
 */
const DETECT_CACHE_TTL_MS = 5000;

export interface AgentEngineRegistryOptions {
  cacheTtlMs?: number;
  now?: () => number;
}

export class AgentEngineRegistry {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: { descriptors: AgentEngineDescriptor[]; expiresAt: number } | null = null;

  constructor(options: AgentEngineRegistryOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DETECT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<AgentEngineDescriptor[]> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.descriptors;
    }

    const detectedAt = now;
    const [codex, claude, mimo, kimi] = await Promise.all([
      this.detectCodex(detectedAt),
      this.detectClaude(detectedAt),
      this.detectMimo(detectedAt),
      this.detectKimi(detectedAt),
    ]);

    const descriptors = [
      this.nativeDescriptor(detectedAt),
      codex,
      claude,
      mimo,
      kimi,
    ];
    this.cache = { descriptors, expiresAt: now + this.cacheTtlMs };
    return descriptors;
  }

  /** 清除探测缓存，强制下次 list() 重新探测（如用户刚安装/重装引擎后） */
  invalidate(): void {
    this.cache = null;
  }

  async get(kind: AgentEngineKind): Promise<AgentEngineDescriptor> {
    const descriptors = await this.list();
    const descriptor = descriptors.find((item) => item.kind === kind);
    if (!descriptor) {
      throw new Error(`Unknown agent engine: ${kind}`);
    }
    return descriptor;
  }

  private nativeDescriptor(detectedAt: number): AgentEngineDescriptor {
    return {
      kind: 'native',
      label: AGENT_ENGINE_LABELS.native,
      summary: 'Neo ConversationRuntime, using the existing provider and permission stack.',
      installState: 'builtin',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute', 'stream_events', 'resume', 'review'],
      defaultPermissionProfile: 'default',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt,
      auditNotes: ['Uses existing model provider, tools, permissions, trace, and review queue.'],
    };
  }

  private async detectCodex(detectedAt: number): Promise<AgentEngineDescriptor> {
    const probe = await this.probeCommand('codex', ['--version']);
    const installed = Boolean(probe.binaryPath && !probe.error);
    const runtimeState: AgentEngineRuntimeState = installed ? 'ready' : 'not_configured';

    return {
      kind: 'codex_cli',
      label: AGENT_ENGINE_LABELS.codex_cli,
      summary: 'Runs Codex CLI through a controlled workspace cwd and normalized event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'codex exec --json',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'review'] : [],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt,
      lastError: probe.error,
      auditNotes: [
        'P0 execution uses read-only sandbox by default.',
        'Launch cwd, command summary, and log path are written to the background task ledger.',
      ],
      reliability: {
        cliStatus: installed ? 'available' : probe.binaryPath ? 'error' : 'missing',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'workspace_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: false,
        mcpBridge: false,
        notes: [
          'Registry detection checks CLI availability only; auth and quota are validated by the CLI run.',
        ],
      },
    };
  }

  private async detectClaude(detectedAt: number): Promise<AgentEngineDescriptor> {
    const probe = await this.probeCommand('claude', ['--version']);
    const installed = Boolean(probe.binaryPath && !probe.error);
    const runtimeState: AgentEngineRuntimeState = installed ? 'ready' : 'not_configured';

    return {
      kind: 'claude_code',
      label: AGENT_ENGINE_LABELS.claude_code,
      summary: 'Runs Claude Code in non-interactive plan mode with read-only tools and normalized event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'claude -p --output-format stream-json --input-format text --include-partial-messages --permission-mode plan',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'review'] : [],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt,
      lastError: probe.error,
      auditNotes: [
        'Execution uses plan permission mode and Read/Glob/Grep/LS tools by default.',
        'The registry intentionally avoids interactive login probes.',
        'Runs with stream-json, partial messages, strict MCP config, and a bounded read-only tool allowlist.',
      ],
      reliability: {
        cliStatus: installed ? 'available' : probe.binaryPath ? 'error' : 'missing',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'read_only_cli_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: true,
        mcpBridge: false,
        notes: [
          'Registry detection checks CLI availability only; auth and quota are validated by the CLI run.',
          'Claude Code adapter ignores terminal clutter and prefers the final result text when present.',
        ],
      },
    };
  }

  private async detectMimo(detectedAt: number): Promise<AgentEngineDescriptor> {
    const probe = await this.probeCommand('mimo', ['--version']);
    const installed = Boolean(probe.binaryPath && !probe.error);
    const runtimeState: AgentEngineRuntimeState = installed ? 'ready' : 'not_configured';

    return {
      kind: 'mimo_code',
      label: AGENT_ENGINE_LABELS.mimo_code,
      summary: 'Runs MiMo-Code CLI through a controlled workspace cwd and normalized JSON event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'mimo run --format json',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'review'] : [],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt,
      lastError: probe.error,
      auditNotes: [
        'P0 execution uses read-only sandbox by default.',
        'Launch cwd, command summary, and log path are written to the background task ledger.',
        'Credentials (OAuth / subscription key) are read by the CLI from MIMO_HOME; the adapter never injects API keys.',
      ],
      reliability: {
        cliStatus: installed ? 'available' : probe.binaryPath ? 'error' : 'missing',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'json',
        toolSupport: 'workspace_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: false,
        mcpBridge: false,
        notes: [
          'Registry detection checks CLI availability only; auth and quota are validated by the CLI run.',
        ],
      },
    };
  }

  private async detectKimi(detectedAt: number): Promise<AgentEngineDescriptor> {
    const probe = await this.probeCommand('kimi', ['--version']);
    const installed = Boolean(probe.binaryPath && !probe.error);
    const runtimeState: AgentEngineRuntimeState = installed ? 'ready' : 'not_configured';

    return {
      kind: 'kimi_code',
      label: AGENT_ENGINE_LABELS.kimi_code,
      summary: 'Runs Kimi Code CLI through a controlled workspace cwd and normalized stream-json event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'kimi -p --output-format stream-json',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'review'] : [],
      defaultPermissionProfile: 'read_only',
      cwdPolicy: 'workspace_only',
      riskTier: 'medium',
      detectedAt,
      lastError: probe.error,
      auditNotes: [
        'P0 execution uses read-only sandbox by default.',
        'Launch cwd, command summary, and log path are written to the background task ledger.',
        'Kimi CLI does not read API keys from env; credentials live under KIMI_CODE_HOME via kimi login / config.toml.',
      ],
      reliability: {
        cliStatus: installed ? 'available' : probe.binaryPath ? 'error' : 'missing',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'workspace_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: false,
        mcpBridge: false,
        notes: [
          'Registry detection checks CLI availability only; auth and quota are validated by the CLI run.',
        ],
      },
    };
  }

  private async probeCommand(command: string, versionArgs: string[]): Promise<CommandProbe> {
    const binaryPath = await this.resolveBinary(command);
    if (!binaryPath) {
      return {
        command,
        error: `${command} was not found on PATH`,
      };
    }

    try {
      const result = await execFileAsync(binaryPath, versionArgs, {
        env: this.getProbeEnv(),
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      }) as ExecProbeResult;
      const version = normalizeVersionOutput(result.stdout || result.stderr);
      return {
        command,
        binaryPath,
        version,
      };
    } catch (error) {
      return {
        command,
        binaryPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveBinary(command: string): Promise<string | undefined> {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    try {
      const result = await execFileAsync(locator, [command], {
        env: this.getProbeEnv(),
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
      }) as ExecProbeResult;
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    } catch {
      return undefined;
    }
  }

  private getProbeEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: getShellPath(),
    };
  }
}

export function normalizeVersionOutput(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

let instance: AgentEngineRegistry | null = null;

export function getAgentEngineRegistry(): AgentEngineRegistry {
  if (!instance) {
    instance = new AgentEngineRegistry();
  }
  return instance;
}
