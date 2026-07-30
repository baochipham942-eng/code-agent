// ============================================================================
// Agent Engine Registry
// ============================================================================

import { execFile } from 'child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'util';
import type {
  AgentEngineDescriptor,
  AgentEngineKind,
  AgentEngineSourceDescriptor,
} from '../../../shared/contract/agentEngine';
import {
  listExternalEngineManifests,
  type ExternalEngineManifest,
} from '../../../shared/externalEngineManifest';
import { getShellPath } from '../infra/shellEnvironment';

const execFileAsync = promisify(execFile);

interface CommandProbe {
  command: string;
  binaryPath?: string;
  version?: string;
  authenticated?: boolean;
  authChecked?: boolean;
  authError?: string;
  error?: string;
}

interface ExecProbeResult {
  stdout: string;
  stderr: string;
}

const VERSION_TIMEOUT_MS = 3000;
const DETECT_CACHE_TTL_MS = 5000;

export interface AgentEngineRegistryOptions {
  cacheTtlMs?: number;
  now?: () => number;
  manifests?: readonly ExternalEngineManifest[];
}

export class AgentEngineRegistry {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly manifests: readonly ExternalEngineManifest[];
  private cache: {
    descriptors: AgentEngineDescriptor[];
    sources: AgentEngineSourceDescriptor[];
    expiresAt: number;
  } | null = null;

  constructor(options: AgentEngineRegistryOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DETECT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.manifests = options.manifests ?? listExternalEngineManifests();
  }

  async list(): Promise<AgentEngineDescriptor[]> {
    await this.ensureCache();
    return this.cache?.descriptors ?? [];
  }

  /**
   * Onboarding / engine picker source list. It deliberately includes recommendation-only
   * manifests, while `list()` remains the executable AgentEngineKind registry.
   */
  async listSources(): Promise<AgentEngineSourceDescriptor[]> {
    await this.ensureCache();
    return this.cache?.sources ?? [];
  }

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

  private async ensureCache(): Promise<void> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return;

    const probes = await Promise.all(this.manifests.map((manifest) => this.probeManifest(manifest)));
    const sources = this.manifests.map((manifest, index) =>
      this.buildSourceDescriptor(manifest, probes[index]));
    const descriptors = this.manifests.flatMap((manifest, index) => {
      if (!manifest.kind) return [];
      return [this.buildEngineDescriptor(manifest, manifest.kind, probes[index], now)];
    });

    this.cache = {
      descriptors,
      sources,
      expiresAt: now + this.cacheTtlMs,
    };
  }

  private buildSourceDescriptor(
    manifest: ExternalEngineManifest,
    probe: CommandProbe | null,
  ): AgentEngineSourceDescriptor {
    const builtin = manifest.kind === 'native';
    const detected = builtin || Boolean(probe?.binaryPath && !probe.error);
    const adapterVerified = manifest.adapter.evidence === 'production'
      && Boolean(manifest.adapter.adapterId)
      && Boolean(manifest.kind);
    const authenticated = builtin || probe?.authenticated === true;
    return {
      manifestId: manifest.id,
      ...(manifest.kind ? { kind: manifest.kind } : {}),
      label: manifest.label,
      summary: manifest.summary,
      ...(manifest.commandSummary ? { command: manifest.commandSummary } : {}),
      ...(probe?.binaryPath ? { binaryPath: probe.binaryPath } : {}),
      ...(probe?.version ? { version: probe.version } : {}),
      detected,
      selectable: detected && adapterVerified && authenticated,
      authState: builtin
        ? 'authenticated'
        : probe?.authenticated
          ? 'authenticated'
          : probe?.authChecked
            ? 'needs_login'
            : 'not_checked',
      modelSelection: manifest.modelSelection,
      ...(manifest.iconAsset ? { iconAsset: manifest.iconAsset } : {}),
      ...(manifest.recommendation ? { recommendation: manifest.recommendation } : {}),
      evidence: manifest.adapter.evidence,
      credentialOwner: manifest.adapter.credentialOwner,
      auditNotes: [
        ...manifest.auditNotes,
        ...(probe?.error ? [`Probe: ${probe.error}`] : []),
        ...(probe?.authError ? [`Auth probe: ${probe.authError}`] : []),
      ],
    };
  }

  private buildEngineDescriptor(
    manifest: ExternalEngineManifest,
    kind: AgentEngineKind,
    probe: CommandProbe | null,
    detectedAt: number,
  ): AgentEngineDescriptor {
    const builtin = kind === 'native';
    const installed = builtin || Boolean(probe?.binaryPath && !probe.error);
    const executable = builtin || (
      installed
      && manifest.adapter.evidence === 'production'
      && Boolean(manifest.adapter.adapterId)
    );
    return {
      manifestId: manifest.id,
      kind,
      label: manifest.label,
      summary: manifest.summary,
      installState: builtin ? 'builtin' : installed ? 'installed' : 'missing',
      runtimeState: executable ? 'ready' : installed ? 'blocked' : 'not_configured',
      executable,
      ...(manifest.commandSummary ? { command: manifest.commandSummary } : {}),
      ...(probe?.binaryPath ? { binaryPath: probe.binaryPath } : {}),
      ...(probe?.version ? { version: probe.version } : {}),
      capabilities: executable ? [...manifest.capabilities] : [],
      defaultPermissionProfile: manifest.defaultPermissionProfile,
      cwdPolicy: 'workspace_only',
      riskTier: manifest.riskTier,
      detectedAt,
      ...(probe?.error ? { lastError: probe.error } : {}),
      auditNotes: [...manifest.auditNotes],
      reliability: {
        cliStatus: builtin || installed ? 'available' : probe?.binaryPath ? 'error' : 'missing',
        authState: 'not_checked',
        quotaState: 'not_checked',
        ...manifest.reliability,
        notes: [
          ...(manifest.reliability.notes ?? []),
          ...(manifest.adapter.credentialOwner === 'official_client'
            ? ['Credentials remain owned by the official client.']
            : []),
        ],
      },
      modelSelection: manifest.modelSelection,
      ...(manifest.iconAsset ? { iconAsset: manifest.iconAsset } : {}),
    };
  }

  private async probeManifest(manifest: ExternalEngineManifest): Promise<CommandProbe | null> {
    if (!manifest.probe) return null;
    let lastResult: CommandProbe | null = null;
    const candidates = [
      ...(manifest.probe.binaryPaths ?? []),
      ...manifest.probe.commands,
    ];
    for (const command of candidates) {
      const result = await this.probeCommand(
        command,
        manifest.probe.versionArgs,
        manifest.probe.authProbe,
        manifest.probe.authStateMarker,
        manifest.probe.timeoutMs,
      );
      if (result.binaryPath && !result.error) return result;
      lastResult = result;
    }
    return lastResult;
  }

  private async probeCommand(
    command: string,
    versionArgs: string[],
    authProbe?: { args: string[]; successPattern: string; failurePattern?: string },
    authStateMarker?: string,
    timeoutMs = VERSION_TIMEOUT_MS,
  ): Promise<CommandProbe> {
    const binaryPath = await this.resolveBinary(command);
    if (!binaryPath) {
      return { command, error: `${command} was not found on PATH` };
    }

    try {
      const result = await execFileAsync(binaryPath, versionArgs, {
        env: this.getProbeEnv(),
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
      }) as ExecProbeResult;
      const baseResult: CommandProbe = {
        command,
        binaryPath,
        version: normalizeVersionOutput(result.stdout || result.stderr),
      };
      if (authStateMarker) {
        const authenticated = await this.pathExists(this.expandHome(authStateMarker));
        return {
          ...baseResult,
          authChecked: true,
          authenticated,
          ...(!authenticated ? { authError: 'Official client login state was not found' } : {}),
        };
      }
      if (!authProbe) return baseResult;

      try {
        const authResult = await execFileAsync(binaryPath, authProbe.args, {
          env: this.getProbeEnv(),
          timeout: timeoutMs,
          maxBuffer: 512 * 1024,
        }) as ExecProbeResult;
        const authOutput = `${authResult.stdout}\n${authResult.stderr}`;
        const authenticated = authOutput.includes(authProbe.successPattern)
          && (!authProbe.failurePattern || !authOutput.includes(authProbe.failurePattern));
        return {
          ...baseResult,
          authChecked: true,
          authenticated,
          ...(!authenticated ? { authError: 'Official client login was not confirmed' } : {}),
        };
      } catch {
        return {
          ...baseResult,
          authChecked: true,
          authenticated: false,
          authError: 'Official client login probe failed',
        };
      }
    } catch (error) {
      return {
        command,
        binaryPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveBinary(command: string): Promise<string | undefined> {
    if (command.startsWith('~/') || isAbsolute(command)) {
      const candidate = this.expandHome(command);
      return await this.pathExists(candidate) ? candidate : undefined;
    }
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

  private expandHome(value: string): string {
    return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  }

  private async pathExists(value: string): Promise<boolean> {
    try {
      await access(value);
      return true;
    } catch {
      return false;
    }
  }

  private getProbeEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: getShellPath() };
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
  if (!instance) instance = new AgentEngineRegistry();
  return instance;
}
