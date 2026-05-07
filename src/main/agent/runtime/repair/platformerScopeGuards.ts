import { type ScopeGuard, scopeGuardRegistry } from './scopeGuards';

export const platformerScopeGuards: ScopeGuard[] = [
  {
    issueCode: 'input_normalizer_missing',
    scopeRegex: /normalizeInput|inputState|step\s*\(|runSmokeTest|forEach|string\[\]|object map/i,
    failureMessage: [
      'Patch does not touch the active validation failure scope: input_normalizer_missing.',
      'This repair must add or use normalizeInput(inputState) in step() and keep runSmokeTest on the same accepted input path.',
      'Do not spend a repair attempt changing unrelated metadata, UI, or styling.',
    ].join(' '),
  },
  {
    issueCode: 'missing_snapshot_metric',
    scopeRegex: /progressPlan|reachability|metric\s*:|snapshot\s*\(|step\s*\(|player\.(?:x|y|vy)|\bprogress\b|expect\s*:/i,
    failureMessage: [
      'Patch does not touch the active validation failure scope: missing_snapshot_metric.',
      'This repair must change progressPlan/reachability metric paths, snapshot() fields, or the step() state update that makes the metric change.',
      'For platformers, prefer metric "player.x" for ArrowRight movement and "player.y" or "player.vy" for jump instead of a missing generic "progress" metric.',
    ].join(' '),
  },
];

// Side-effect 自注册：任何 import 本模块的位置都会触发 platformer scope guards
// 注册到全局 registry。OCP — scopeGuards.ts 不再需要 import 本文件。
for (const guard of platformerScopeGuards) {
  scopeGuardRegistry.register(guard);
}
