// ============================================================================
// Proposal CLI — Self-Evolving v2.5 Phase 3 + V3-γ Parallelism
//
// Commands:
//   proposal list [--status pending|applied|...]
//   proposal show <id>
//   proposal eval <id> [--parallel] [--concurrency N]
//   proposal eval-all [--concurrency N]
//   proposal apply <id>
//   proposal reject <id> [--reason "..."]
//
// Usage: npx tsx scripts/proposal-cli.ts <command> [...]
// ============================================================================

import {
  loadAllProposals,
  updateStatus,
  defaultProposalsDir,
  ShadowEvaluator,
  scanConflictsInDir,
  defaultConflictDirs,
  readAttributionCategoriesFromDir,
  defaultGraderReportsDir,
  applyProposal,
  runRegressionGateViaCli,
  evaluateBatch,
  type Proposal,
  type ProposalStatus,
  type ShadowEvalResult,
} from '../src/main/evaluation/proposals';

function parseArgs(): {
  cmd: string;
  id?: string;
  status?: string;
  reason?: string;
  parallel?: boolean;
  concurrency?: number;
} {
  const [, , cmd = 'list', ...rest] = process.argv;
  const out: {
    cmd: string;
    id?: string;
    status?: string;
    reason?: string;
    parallel?: boolean;
    concurrency?: number;
  } = { cmd };

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--status' && rest[i + 1]) {
      out.status = rest[++i];
    } else if (a === '--reason' && rest[i + 1]) {
      out.reason = rest[++i];
    } else if (a === '--parallel') {
      out.parallel = true;
    } else if (a === '--concurrency' && rest[i + 1]) {
      out.concurrency = parseInt(rest[++i], 10);
    } else if (!a.startsWith('--') && !out.id) {
      out.id = a;
    }
  }
  return out;
}

async function resolveProposal(id: string, dir: string): Promise<Proposal> {
  const all = await loadAllProposals(dir);
  const found = all.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Proposal not found: ${id} (in ${dir})`);
  }
  return found;
}

async function cmdList(statusFilter: string | undefined, dir: string) {
  const all = await loadAllProposals(dir);
  const filtered = statusFilter
    ? all.filter((p) => p.status === statusFilter)
    : all;
  console.log(`\n${filtered.length} proposal(s) in ${dir}\n`);
  if (filtered.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const p of filtered) {
    const rec = p.shadowEval?.recommendation ?? '—';
    const score =
      p.shadowEval?.score != null ? p.shadowEval.score.toFixed(2) : '—';
    console.log(
      `  ${p.id}  [${p.status.padEnd(14)}]  rec=${rec.padEnd(12)} score=${score}`
    );
    console.log(`    ${truncate(p.hypothesis, 90)}`);
  }
  console.log();
}

async function cmdShow(id: string, dir: string) {
  const p = await resolveProposal(id, dir);
  console.log(`\n── ${p.id} ──`);
  console.log(`status:              ${p.status}`);
  console.log(`createdAt:           ${p.createdAt}`);
  console.log(`type:                ${p.type}`);
  console.log(`tags:                ${p.tags.join(', ')}`);
  console.log(`hypothesis:          ${p.hypothesis}`);
  console.log(`targetMetric:        ${p.targetMetric}`);
  console.log(`rollbackCondition:   ${p.rollbackCondition}`);
  if (p.shadowEval) {
    console.log('\nshadowEval:');
    console.log(`  recommendation:    ${p.shadowEval.recommendation}`);
    console.log(`  score:             ${p.shadowEval.score.toFixed(2)}`);
    console.log(`  regressionGate:    ${p.shadowEval.regressionGateDecision}`);
    console.log(`  conflictsWith:     ${p.shadowEval.conflictsWith.length} file(s)`);
    console.log(
      `  addressesCats:     ${p.shadowEval.addressesCategories
        .map((c) => `${c.category}(${c.hits})`)
        .join(', ') || '(none)'}`
    );
    console.log(`  reason:            ${p.shadowEval.reason}`);
  } else {
    console.log('\nshadowEval:           (not yet evaluated)');
  }
  if (p.ruleContent) {
    console.log('\nruleContent:');
    console.log(p.ruleContent);
  }
  console.log();
}

function buildDeps() {
  return {
    scanConflicts: (proposal: Proposal) => scanConflictsInDir(proposal, defaultConflictDirs()),
    readAttributionCategories: () =>
      readAttributionCategoriesFromDir(defaultGraderReportsDir()),
    runRegressionGate: () => runRegressionGateViaCli(),
  };
}

function toNextStatus(recommendation: ShadowEvalResult['recommendation']): ProposalStatus {
  return recommendation === 'apply'
    ? 'shadow_passed'
    : recommendation === 'reject'
      ? 'shadow_failed'
      : 'needs_human';
}

async function cmdEval(id: string, dir: string) {
  const p = await resolveProposal(id, dir);
  console.log(`Evaluating ${p.id}...`);

  const evaluator = new ShadowEvaluator(buildDeps());
  const result = await evaluator.evaluate(p);
  const nextStatus = toNextStatus(result.recommendation);

  await updateStatus(p.filePath, nextStatus, { shadowEval: result });

  console.log(`  recommendation: ${result.recommendation}`);
  console.log(`  score:          ${result.score.toFixed(2)}`);
  console.log(`  regressionGate: ${result.regressionGateDecision}`);
  console.log(`  conflicts:      ${result.conflictsWith.length}`);
  console.log(
    `  addressesCats:  ${result.addressesCategories
      .map((c) => `${c.category}(${c.hits})`)
      .join(', ') || '(none)'}`
  );
  console.log(`  reason:         ${result.reason}`);
  console.log(`  → status:       ${nextStatus}`);
}

async function cmdEvalAll(dir: string, concurrency?: number) {
  const all = await loadAllProposals(dir);
  const pending = all.filter((p) => p.status === 'pending');

  if (pending.length === 0) {
    console.log('\nNo pending proposals to evaluate.\n');
    return;
  }

  console.log(`\nEvaluating ${pending.length} pending proposal(s) in batch (concurrency=${concurrency ?? 3})...\n`);

  const results = await evaluateBatch(pending, buildDeps(), { concurrency });

  console.log('  ID                      Score  Recommendation  Reason');
  console.log('  ' + '-'.repeat(80));

  for (const { proposal, result } of results) {
    const nextStatus = toNextStatus(result.recommendation);
    await updateStatus(proposal.filePath, nextStatus, { shadowEval: result });

    console.log(
      `  ${proposal.id.padEnd(24)}  ${result.score.toFixed(2).padStart(5)}  ${result.recommendation.padEnd(14)}  ${truncate(result.reason, 50)}`
    );
  }
  console.log();
}

async function cmdApply(id: string, dir: string) {
  const p = await resolveProposal(id, dir);
  const result = await applyProposal(p.filePath);
  console.log(`Applied ${p.id} → ${result.experimentId}`);
  console.log(`  experimentPath: ${result.experimentPath}`);
}

async function cmdReject(id: string, reason: string | undefined, dir: string) {
  const p = await resolveProposal(id, dir);
  await updateStatus(p.filePath, 'rejected');
  console.log(`Rejected ${p.id}${reason ? ` — ${reason}` : ''}`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function main() {
  const args = parseArgs();
  const dir = defaultProposalsDir();

  switch (args.cmd) {
    case 'list':
      await cmdList(args.status, dir);
      break;
    case 'show':
      if (!args.id) throw new Error('proposal show <id>');
      await cmdShow(args.id, dir);
      break;
    case 'eval':
      if (!args.id) throw new Error('proposal eval <id>');
      await cmdEval(args.id, dir);
      break;
    case 'eval-all':
      await cmdEvalAll(dir, args.concurrency);
      break;
    case 'apply':
      if (!args.id) throw new Error('proposal apply <id>');
      await cmdApply(args.id, dir);
      break;
    case 'reject':
      if (!args.id) throw new Error('proposal reject <id>');
      await cmdReject(args.id, args.reason, dir);
      break;
    default:
      console.error(
        `Unknown command: ${args.cmd}\nUsage: proposal [list|show|eval|eval-all|apply|reject] [id] [--status ...] [--reason ...] [--parallel] [--concurrency N]`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
