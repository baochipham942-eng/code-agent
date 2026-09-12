/**
 * Breakout-specific 失败码与匹配规则。与 platformer/runner repairCodes.ts 同形。
 *
 * 整契约崩溃（可玩循环写完、零 META/TEST）走 missing_breakout_contract，
 * 不要散射成 8 条通用 missing_* 零件码。
 */
import type { ArtifactRepairIssueSeverity } from '../../artifactRepairSpec';

export type BreakoutRepairCode = 'missing_breakout_contract';

export interface BreakoutRepairEntry {
  code: BreakoutRepairCode;
  pattern: RegExp;
  severity: ArtifactRepairIssueSeverity;
  message: string;
  repairInstruction: string;
  hints: readonly string[];
}

export const BREAKOUT_REPAIR_CODES: readonly BreakoutRepairEntry[] = [
  {
    code: 'missing_breakout_contract',
    pattern:
      /breakout 缺少 window\.__GAME_(?:META|TEST)__|可玩的挡板\/弹球循环写完也不算交付|breakout contract objects missing/i,
    severity: 'error',
    message: 'Breakout artifact finished the playable loop without __GAME_META__ / __GAME_TEST__.',
    repairInstruction:
      'Do not close </html> until both window.__GAME_META__ and window.__GAME_TEST__ are assigned as one direct object literal each. Keep the live paddle/ball/brick loop, then add subtype: \'breakout\', dispatchable controls, powerups [\'wide\',\'multi\',\'slow\',\'through\',\'life\'], and quoted reset ids paddleMove, launch, wallBounce, paddleBounce, brickHit, powerup:wide, powerup:multi, powerup:slow, powerup:through, powerup:life, win, lose. __GAME_TEST__ must expose start(), reset(levelOrScenario), snapshot(), step(inputState, frames), and runSmokeTest() that drive the same live state.',
    hints: [
      'Place the two object assignments before </html>, after the playable loop is wired. A finished canvas game without those objects is an incomplete artifact.',
      'snapshot() should expose paddleX or paddle.x, ball.x/y plus velocity, wallBounceCount, paddleBounceCount, brickCount or bricksRemaining, score, lives, status, and powerupsTriggered.',
    ],
  },
];

const ENTRY_BY_CODE: ReadonlyMap<BreakoutRepairCode, BreakoutRepairEntry> = new Map(
  BREAKOUT_REPAIR_CODES.map((entry) => [entry.code, entry]),
);

export function lookupBreakoutRepair(code: string): BreakoutRepairEntry | undefined {
  return ENTRY_BY_CODE.get(code as BreakoutRepairCode);
}

export function classifyBreakoutFailure(text: string): BreakoutRepairEntry | undefined {
  for (const entry of BREAKOUT_REPAIR_CODES) {
    if (entry.pattern.test(text)) return entry;
  }
  return undefined;
}

export const BREAKOUT_REPAIR_CODE_SET: ReadonlySet<BreakoutRepairCode> = new Set(
  BREAKOUT_REPAIR_CODES.map((entry) => entry.code),
);
