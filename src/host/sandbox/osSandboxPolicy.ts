// ============================================================================
// OS sandbox policy — default-on for gray-released permission modes
// ============================================================================
//
// shouldSandbox used to be "one of four special cases". This module flips that
// to "default true, explicit exceptions" for `default` / `acceptEdits`.
// Adding an unsandboxable exception relaxes isolation — each entry must say why.

import { OS_SANDBOX_CODES, isOsSandboxEnabled, type OsSandboxCode } from '../../shared/constants/sandbox';

export type OsSandboxPermissionMode =
  | 'default'
  | 'readOnly'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'
  | 'delegate';

export interface OsSandboxDecisionInput {
  command: string;
  permissionMode: OsSandboxPermissionMode;
  unattended: boolean;
  writeFence: boolean;
  evalRealRoot: boolean;
  multiRoot: boolean;
  sandboxAvailable: boolean;
  sandboxEnabled?: boolean;
  platform?: NodeJS.Platform;
}

export interface OsSandboxDecision {
  /** Wrap with seatbelt/bwrap. */
  apply: boolean;
  /** True only when the command will actually run inside the OS jail. */
  sandboxed: boolean;
  /** Explicit unsandboxed run (never a silent naked fallback). */
  degraded: boolean;
  /** Wrap failure may fall back to a marked unsandboxed run. */
  degradeIfUnavailable: boolean;
  code: OsSandboxCode;
  /** Whitelist exception id when code is DEGRADED_UNSANDBOXABLE. */
  exception?: string;
}

export interface UnsandboxableException {
  id: string;
  /** Why this class cannot run inside the OS jail. Required: each add is a relaxation. */
  reason: string;
  match: (command: string, platform: NodeJS.Platform) => boolean;
}

const COMMAND_TOKEN = (names: string[]): RegExp => new RegExp(
  `(?:^|[\\s;&|()])(?:sudo\\s+|command\\s+|env\\s+)?(?:${names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?=$|[\\s;&|()])`,
  'i',
);

const DOCKER_ENGINE_PATTERN = COMMAND_TOKEN(['docker', 'podman', 'nerdctl']);
const MACOS_LAUNCH_PATTERN = COMMAND_TOKEN(['open', 'osascript']);

/**
 * Commands that cannot function inside seatbelt/bwrap.
 * Default/acceptEdits may degrade with an explicit mark; required modes (bypass,
 * unattended, write-fence, eval, multi-root) still wrap — a failed jail is
 * safer than a silent hole in those paths.
 */
export const UNSANDBOXABLE_EXCEPTIONS: readonly UnsandboxableException[] = [
  {
    id: 'docker_engine',
    reason:
      'Docker/podman/nerdctl talk to a host engine unix socket that seatbelt/bwrap deny. '
      + 'Sandboxing only yields a false failure; default/acceptEdits still need `docker build`.',
    match: (command) => DOCKER_ENGINE_PATTERN.test(command),
  },
  {
    id: 'macos_launch_services',
    reason:
      '`open` and `osascript` need LaunchServices / Apple Events that sandbox-exec blocks. '
      + 'Common macOS cowork actions cannot complete inside the profile.',
    match: (command, platform) => platform === 'darwin' && MACOS_LAUNCH_PATTERN.test(command),
  },
];

export function classifyUnsandboxableCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): UnsandboxableException | undefined {
  return UNSANDBOXABLE_EXCEPTIONS.find((entry) => entry.match(command, platform));
}

function isRolloutMode(mode: OsSandboxPermissionMode): boolean {
  return mode === 'default' || mode === 'acceptEdits';
}

function isRequiredSandboxContext(input: OsSandboxDecisionInput): boolean {
  return input.writeFence
    || input.unattended
    || input.evalRealRoot
    || input.multiRoot
    || input.permissionMode === 'bypassPermissions';
}

/**
 * Decide whether bash must wrap, may degrade, or is outside the gray rollout.
 *
 * Reverse mutation: returning apply=false for default/acceptEdits when enabled
 * and available (and the command is sandboxable) is a product regression.
 */
export function resolveOsSandboxDecision(input: OsSandboxDecisionInput): OsSandboxDecision {
  const enabled = input.sandboxEnabled ?? isOsSandboxEnabled();
  const platform = input.platform ?? process.platform;
  const required = isRequiredSandboxContext(input);
  const rollout = isRolloutMode(input.permissionMode);

  if (input.writeFence) {
    return {
      apply: true,
      sandboxed: true,
      degraded: false,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.APPLIED,
    };
  }

  if (!enabled) {
    // Master switch off: same as the old env-gated default, except write-fence
    // already returned above. Required modes do not silently keep wrapping.
    return {
      apply: false,
      sandboxed: false,
      degraded: rollout,
      degradeIfUnavailable: false,
      code: rollout ? OS_SANDBOX_CODES.DEGRADED_DISABLED : OS_SANDBOX_CODES.MODE_NOT_IN_ROLLOUT,
    };
  }

  if (!required && !rollout) {
    return {
      apply: false,
      sandboxed: false,
      degraded: false,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.MODE_NOT_IN_ROLLOUT,
    };
  }

  const unsandboxable = !required ? classifyUnsandboxableCommand(input.command, platform) : undefined;
  if (unsandboxable) {
    return {
      apply: false,
      sandboxed: false,
      degraded: true,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.DEGRADED_UNSANDBOXABLE,
      exception: unsandboxable.id,
    };
  }

  // multiRoot 也降级：多根在旧默认（env 未开）下本就裸跑，无沙箱平台（CI ubuntu
  // 无 bwrap / Windows）硬报错会把一直在用的会话打死；降级带标记不静默。
  // bypass / unattended / write-fence / eval 仍硬失败（fail-closed）。
  const degradeIfUnavailable = (rollout && !required) || input.multiRoot;
  if (!input.sandboxAvailable) {
    if (degradeIfUnavailable) {
      return {
        apply: false,
        sandboxed: false,
        degraded: true,
        degradeIfUnavailable: true,
        code: OS_SANDBOX_CODES.DEGRADED_UNAVAILABLE,
      };
    }
    return {
      apply: true,
      sandboxed: true,
      degraded: false,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.APPLIED,
    };
  }

  return {
    apply: true,
    sandboxed: true,
    degraded: false,
    degradeIfUnavailable,
    code: OS_SANDBOX_CODES.APPLIED,
  };
}
