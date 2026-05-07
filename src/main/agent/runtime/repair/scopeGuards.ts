export interface ScopeGuard {
  issueCode: string;
  scopeRegex: RegExp;
  failureMessage: string;
}

class ScopeGuardRegistry {
  private readonly guards = new Map<string, ScopeGuard>();

  register(guard: ScopeGuard): void {
    this.guards.set(guard.issueCode, guard);
  }

  check(issueCodes: readonly string[], patchText: string): string | null {
    if (!patchText.trim()) return null;

    for (const issueCode of issueCodes) {
      const guard = this.guards.get(issueCode);
      if (guard && !guard.scopeRegex.test(patchText)) {
        return guard.failureMessage;
      }
    }

    return null;
  }
}

export const scopeGuardRegistry = new ScopeGuardRegistry();

const metadataScopeRegex =
  /__GAME_META__|__INTERACTIVE_META__|controls|levels|scenarios|objectives|segments|missions|reachability|progressPlan|acceptance|validation|qualityPlan|actorReadable|allAuthoredLevelsReachable/i;

const metadataScopeMessage = [
  'Patch does not touch the active validation metadata scope.',
  'This repair must add or update literal __GAME_META__/__INTERACTIVE_META__ metadata with controls, authored scope, reachability/progressPlan, and quality/acceptance fields.',
  'Do not spend a repair attempt changing unrelated gameplay or UI code before metadata is fixed.',
].join(' ');

const genericScopeGuards: ScopeGuard[] = [
  {
    issueCode: 'coverage_without_runtime_evidence',
    scopeRegex: /runSmokeTest|coverage|mechanics|rewards|risks|stateChanges|step\s*\(|snapshot\s*\(|Auto-collect|Auto-reach|direct grants|registered|exists|present/i,
    failureMessage: [
      'Patch does not touch the active validation failure scope: coverage_without_runtime_evidence.',
      'This repair must change runSmokeTest/coverage evidence, step/snapshot evidence flow, or remove direct grants/existence-based coverage.',
      'Do not spend a repair attempt changing unrelated start/reset/UI code.',
    ].join(' '),
  },
  {
    issueCode: 'malformed_test_contract',
    scopeRegex:
      /duplicate|orphan(?:ed)?|window\.__(?:GAME|INTERACTIVE)_TEST__\s*=[\s\S]*(?:runSmokeTest|start\s*\(|reset\s*\(|snapshot\s*\(|step\s*\()/i,
    failureMessage: [
      'Patch does not touch the active validation failure scope: malformed_test_contract.',
      'This repair must replace the full active `window.__GAME_TEST__` / `window.__INTERACTIVE_TEST__` block or remove the duplicate orphaned contract tail after it closes.',
      'Do not spend a repair attempt changing inner gameplay checks before the active test contract structure is repaired.',
    ].join(' '),
  },
  {
    issueCode: 'missing_controls_metadata',
    scopeRegex: metadataScopeRegex,
    failureMessage: metadataScopeMessage,
  },
  {
    issueCode: 'missing_coverage_metadata',
    scopeRegex: metadataScopeRegex,
    failureMessage: metadataScopeMessage,
  },
  {
    issueCode: 'missing_reachability_metadata',
    scopeRegex: metadataScopeRegex,
    failureMessage: metadataScopeMessage,
  },
  {
    issueCode: 'missing_quality_metadata',
    scopeRegex: metadataScopeRegex,
    failureMessage: metadataScopeMessage,
  },
];

// Generic guards 在 module load 时自注册。subtype-specific guards
// (platformer / runner / ...) 由各自 checker 模块通过 side-effect import
// 自注册——本文件不再 import 任何 subtype 文件，遵循 OCP。
for (const guard of genericScopeGuards) {
  scopeGuardRegistry.register(guard);
}
