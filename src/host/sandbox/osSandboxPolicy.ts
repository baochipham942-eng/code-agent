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
  /** Raw OS_SANDBOX_ENABLED env value; 'true' = operator opt-in to strict required semantics. */
  sandboxEnv?: string;
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

interface UnsandboxableException {
  id: string;
  /** Why this class cannot run inside the OS jail. Required: each add is a relaxation. */
  reason: string;
  match: (command: string, platform: NodeJS.Platform) => boolean;
}

// Command-position only: the name must start the command or follow a shell
// command separator (`;` `&` `|` `(`). Matching plain arguments (e.g. `echo
// docker`, `cat open`) would false-positive into a degraded naked run.
// ponytail: quotes and newlines are not command syntax here — `git commit -m
// "wip; open later"` false-positives into the exception (degrades, no worse
// than baseline), and `cd x\ndocker build .` misses the exception (wraps and
// fails inside the jail). Both fail toward the old behavior, not toward a
// wider hole; shell-token parsing belongs to commandParse if this ever bites.
const COMMAND_TOKEN = (names: string[]): RegExp => new RegExp(
  `(?:^|[;&|(])\\s*(?:sudo\\s+|command\\s+|env\\s+)?(?:${names
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
const UNSANDBOXABLE_EXCEPTIONS: readonly UnsandboxableException[] = [
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

function classifyUnsandboxableCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): UnsandboxableException | undefined {
  return UNSANDBOXABLE_EXCEPTIONS.find((entry) => entry.match(command, platform));
}

function isRolloutMode(mode: OsSandboxPermissionMode): boolean {
  return mode === 'default' || mode === 'acceptEdits';
}

/**
 * Decide whether bash must wrap, may degrade, or is outside the gray rollout.
 *
 * Reverse mutation: returning apply=false for default/acceptEdits when enabled
 * and available (and the command is sandboxable) is a product regression.
 */
export function resolveOsSandboxDecision(input: OsSandboxDecisionInput): OsSandboxDecision {
  const enabled = input.sandboxEnabled ?? isOsSandboxEnabled();
  const envRaw = input.sandboxEnv
    ?? (typeof process === 'undefined' ? undefined : process.env.OS_SANDBOX_ENABLED);
  const explicitOptIn = envRaw === 'true';
  const platform = input.platform ?? process.platform;
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
    // 紧急刹车：恢复翻默认前行为（任何档都不 wrap），刹车只能由操作者在
    // 进程启动时拉（模型改不了宿主进程 env），所以不 fail-closed——但一律
    // 带降级标记，不静默。强制场景的 fail-closed 作用于「开关开但沙箱
    // 不可用」，不作用于这条显式刹车。
    return {
      apply: false,
      sandboxed: false,
      degraded: true,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.DEGRADED_DISABLED,
    };
  }

  // 严格强制（不可用硬失败、不走白名单例外）：eval 永远严格（红线只认 jail）；
  // bypass / unattended / 多根仅在操作者显式 OS_SANDBOX_ENABLED=true 时严格
  // ——这是 main 的旧 opt-in 语义。env 未设时它们按灰度处理：可用就 wrap、
  // 不可用降级带标记、可走例外；否则 Windows / 无 bwrap Linux 上一直在用的
  // cron 与 bypass 会话会被默认硬失败打死（PR #1789 claude 复审 Important；
  // 与 R1 多根同一条理由，适用面一致）。
  const strictRequired = input.evalRealRoot
    || ((input.unattended || input.permissionMode === 'bypassPermissions' || input.multiRoot)
      && explicitOptIn);
  const wraps = strictRequired || rollout
    || input.unattended || input.permissionMode === 'bypassPermissions' || input.multiRoot;

  if (!wraps) {
    return {
      apply: false,
      sandboxed: false,
      degraded: false,
      degradeIfUnavailable: false,
      code: OS_SANDBOX_CODES.MODE_NOT_IN_ROLLOUT,
    };
  }

  const unsandboxable = !strictRequired
    ? classifyUnsandboxableCommand(input.command, platform)
    : undefined;
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

  const degradeIfUnavailable = !strictRequired;
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
