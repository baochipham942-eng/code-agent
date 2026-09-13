// ============================================================================
// OS sandbox probe — doctor / CLI / settings share this snapshot
// ============================================================================

import * as os from 'os';
import * as path from 'path';
import { OS_SANDBOX_ROLLOUT_MODES, isOsSandboxEnabled } from '../../shared/constants/sandbox';
import { getSandboxManager, type SandboxManagerStatus } from './manager';
import { getSensitiveSandboxPaths, type SensitiveSandboxPath } from './sensitivePaths';

export interface OsSandboxProbe extends SandboxManagerStatus {
  enabled: boolean;
  rolloutModes: readonly string[];
  writePolicy: string;
  networkPolicy: string;
  sensitiveDeny: SensitiveSandboxPath[];
  installHint: string;
}

function displayPath(filePath: string, homeDir: string): string {
  const resolvedHome = path.resolve(homeDir);
  if (filePath === resolvedHome || filePath.startsWith(`${resolvedHome}${path.sep}`)) {
    return `~${filePath.slice(resolvedHome.length)}`;
  }
  return filePath;
}

function osSandboxInstallHint(
  platform: NodeJS.Platform = process.platform,
  available: boolean,
): string {
  if (available) return 'OS sandbox is ready.';
  if (platform === 'linux') {
    return 'Install bubblewrap (bwrap) and retry. Commands in default/acceptEdits will degrade until it is available.';
  }
  if (platform === 'darwin') {
    return 'sandbox-exec is missing or failed preflight. Commands in default/acceptEdits will degrade until Seatbelt is available.';
  }
  return 'This platform has no OS process sandbox. Commands in default/acceptEdits degrade instead of failing closed.';
}

export function probeOsSandbox(options: {
  homeDir?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>;
} = {}): OsSandboxProbe {
  const status = getSandboxManager().getStatus();
  const homeDir = options.homeDir ?? os.homedir();
  const sensitiveDeny = getSensitiveSandboxPaths({
    homeDir,
    env: options.env,
  }).map((entry) => ({
    kind: entry.kind,
    path: displayPath(entry.path, homeDir),
  }));

  return {
    ...status,
    enabled: isOsSandboxEnabled(),
    rolloutModes: OS_SANDBOX_ROLLOUT_MODES,
    writePolicy: 'Writes are confined to the workspace, TMPDIR, and the per-command npm sandbox home.',
    networkPolicy: 'Network is denied unless the command matches the host network allowlist; redline commands stay offline.',
    sensitiveDeny,
    installHint: osSandboxInstallHint(
      status.platform === 'linux' || status.platform === 'darwin' ? status.platform : process.platform,
      status.available,
    ),
  };
}

export function formatOsSandboxProbe(probe: OsSandboxProbe): string {
  const lines = [
    'OS sandbox',
    `  platform:     ${probe.platform}`,
    `  technology:   ${probe.technology ?? 'none'}`,
    `  available:    ${probe.available ? 'yes' : 'no'}`,
    `  enabled:      ${probe.enabled ? 'yes' : 'no'}`,
    `  rollout:      ${probe.rolloutModes.join(', ')}`,
    `  write:        ${probe.writePolicy}`,
    `  network:      ${probe.networkPolicy}`,
    `  sensitive:    ${probe.sensitiveDeny.slice(0, 8).map((entry) => entry.path).join(', ')}${probe.sensitiveDeny.length > 8 ? `, … (${probe.sensitiveDeny.length} paths)` : ''}`,
  ];
  if (probe.error) lines.push(`  error:        ${probe.error}`);
  lines.push(`  install:      ${probe.installHint}`);
  return lines.join('\n');
}
