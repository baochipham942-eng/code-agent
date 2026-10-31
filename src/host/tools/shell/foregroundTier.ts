// 前台命令超时分档：桌面交互会话保持 BASH.DEFAULT_TIMEOUT；channel / cron / role-wake
// 会话走短档（BASH.SHORT_TIER_TIMEOUT），并带 no-wait 守卫——结果会自动送达，等待只会拖慢会话。
import { BASH } from '../../../shared/constants';

export type ForegroundTimeoutTier = 'interactive' | 'short';

const SHORT_TIER_ENV = 'CODE_AGENT_BASH_SHORT_TIMEOUT_MS';
const shortTierSessions = new Set<string>();

export function markShortTierSession(sessionId: string): void {
  shortTierSessions.add(sessionId);
}

export function resolveForegroundTimeoutTier(sessionId?: string): ForegroundTimeoutTier {
  return sessionId && shortTierSessions.has(sessionId) ? 'short' : 'interactive';
}

function resolveShortTierTimeoutMs(): number {
  const override = Number(process.env[SHORT_TIER_ENV]);
  return Number.isFinite(override) && override > 0 ? override : BASH.SHORT_TIER_TIMEOUT;
}

const NO_WAIT_HINT = 'Results and background task output arrive automatically; do not wait. Continue with other work.';

/** `sleep` 位于任一管道段/`;`/`&&`/`||` 之后的命令位置时返回拒绝文案。 */
export function checkNoWaitCommand(command: string): string | null {
  for (const segment of command.split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/);
    const first = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (first === 'sleep') {
      return `Refused: \`sleep\` is not allowed in this session. ${NO_WAIT_HINT}`;
    }
  }
  return null;
}

export function clampToShortTier(requested: number | undefined): { timeout: number; note?: string } {
  const tierMs = resolveShortTierTimeoutMs();
  if (!requested || requested <= tierMs) return { timeout: requested || tierMs };
  return {
    timeout: tierMs,
    note: `Requested timeout ${requested / 1000}s exceeds the ${tierMs / 1000}s limit for this session and was clamped. ${NO_WAIT_HINT}`,
  };
}

/** Process poll/output 的阻塞等待：短档会话超过档位直接拒绝；未指定时取档位。 */
export function resolveShortTierWait(requested: number | undefined): { timeout: number; refusal?: string } {
  const tierMs = resolveShortTierTimeoutMs();
  if (requested === undefined) return { timeout: tierMs };
  if (requested > tierMs) {
    return {
      timeout: tierMs,
      refusal: `Refused: waiting ${requested / 1000}s on a background task exceeds the ${tierMs / 1000}s limit for this session. ${NO_WAIT_HINT}`,
    };
  }
  return { timeout: requested };
}

export function exceededShortTierMessage(timeoutMs: number): string {
  return `Command exceeded the ${timeoutMs / 1000}s foreground limit for this session and was terminated (background execution is disabled in unattended sessions). Split it into shorter commands.`;
}
