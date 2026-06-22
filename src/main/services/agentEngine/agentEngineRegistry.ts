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

export class AgentEngineRegistry {
  async list(): Promise<AgentEngineDescriptor[]> {
    const detectedAt = Date.now();
    const [codex, claude] = await Promise.all([
      this.detectCodex(detectedAt),
      this.detectClaude(detectedAt),
    ]);

    return [
      this.nativeDescriptor(detectedAt),
      codex,
      claude,
    ];
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
      label: 'Neo',
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
      label: 'Codex CLI',
      summary: 'Runs Codex CLI through a controlled workspace cwd and normalized event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'codex exec --json',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'import_sessions', 'review'] : ['import_sessions'],
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
      label: 'Claude Code',
      summary: 'Runs Claude Code in non-interactive plan mode with read-only tools and normalized event stream.',
      installState: installed ? 'installed' : 'missing',
      runtimeState,
      executable: installed,
      command: 'claude -p --output-format stream-json --input-format text --include-partial-messages --permission-mode plan',
      binaryPath: probe.binaryPath,
      version: probe.version,
      capabilities: installed ? ['execute', 'stream_events', 'import_sessions', 'review'] : ['import_sessions'],
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
