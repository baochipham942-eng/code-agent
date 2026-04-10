// ============================================================================
// Evidence Graph CLI — V3-beta
//
// 查询 evidence graph 的命令行工具。
//
// Usage:
//   npx tsx scripts/evidence-graph.ts <command> [options]
//
// Commands:
//   summary                      Dashboard 概览
//   rule-coverage <ruleId>       规则覆盖的 session
//   category-impact <category>   解决某 category 的规则
//   rule-evolution <familyId>    规则家族版本历史
//   rule-effectiveness <ruleId>  规则应用前后效果对比
//   migrate                      运行一次性迁移
//   snapshot <category>          记录当前 category 成功率快照
// ============================================================================

import { EvidenceDb, DEFAULT_DB_PATH } from '../src/main/evaluation/evidence/evidenceDb';
import {
  getRuleCoverage,
  getCategoryImpact,
  getRuleEvolution,
  getRuleEffectiveness,
  getSummary,
} from '../src/main/evaluation/evidence/evidenceQueries';

function usage(): void {
  console.log(`
Usage: npx tsx scripts/evidence-graph.ts <command> [options]

Commands:
  summary                      Dashboard overview
  rule-coverage <ruleId>       Sessions covered by rule
  category-impact <category>   Rules addressing category
  rule-evolution <familyId>    Version history
  rule-effectiveness <ruleId>  Before/after success rate
  migrate                      Run one-time migration (delegates to evidence-migrate.ts)
  snapshot <category> --total <n> --failures <n> --start <date> --end <date>
                               Take success rate snapshot

Options:
  --db-path <path>             Custom database path (default: ~/.claude/evidence-graph.db)
`);
}

function parseArgs(): { command: string; arg?: string; dbPath?: string; extra: Record<string, string> } {
  const argv = process.argv.slice(2);
  let command = '';
  let arg: string | undefined;
  let dbPath: string | undefined;
  const extra: Record<string, string> = {};

  let i = 0;
  // 第一个非 -- 参数是 command
  while (i < argv.length) {
    if (argv[i] === '--db-path' && argv[i + 1]) {
      dbPath = argv[++i];
      i++;
      continue;
    }
    if (argv[i].startsWith('--') && argv[i + 1]) {
      extra[argv[i].slice(2)] = argv[i + 1];
      i += 2;
      continue;
    }
    if (!command) {
      command = argv[i];
    } else if (!arg) {
      arg = argv[i];
    }
    i++;
  }

  return { command, arg, dbPath, extra };
}

function main(): void {
  const { command, arg, dbPath, extra } = parseArgs();

  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }

  if (command === 'migrate') {
    // 委托给 evidence-migrate.ts
    console.log('Delegating to evidence-migrate.ts...');
    console.log('Run: npx tsx scripts/evidence-migrate.ts' + (dbPath ? ` --db-path ${dbPath}` : ''));
    return;
  }

  const db = new EvidenceDb(dbPath ?? DEFAULT_DB_PATH);
  db.initialize();

  try {
    switch (command) {
      case 'summary': {
        const result = getSummary(db.getDb());
        console.log('\n── Evidence Graph Summary ──\n');
        console.log(`  Evidence:  ${result.totalEvidence}`);
        console.log(`  Proposals: ${result.totalProposals}`);
        console.log(`  Rules:     ${result.totalRules}`);
        console.log('\n  Category Breakdown:');
        if (result.categoryBreakdown.size === 0) {
          console.log('    (empty)');
        }
        for (const [cat, cnt] of result.categoryBreakdown) {
          console.log(`    ${cat.padEnd(20)} ${cnt}`);
        }
        break;
      }

      case 'rule-coverage': {
        if (!arg) { console.error('Missing ruleId argument'); process.exit(1); }
        const result = getRuleCoverage(db.getDb(), arg);
        console.log(`\n── Rule Coverage: ${arg} ──\n`);
        console.log(`  Sessions (${result.sessions.length}):`);
        for (const s of result.sessions) console.log(`    - ${s}`);
        console.log(`  Categories: ${result.categories.join(', ') || '(none)'}`);
        console.log(`  Proposal chain: ${result.proposalChain.join(' -> ') || '(none)'}`);
        break;
      }

      case 'category-impact': {
        if (!arg) { console.error('Missing category argument'); process.exit(1); }
        const result = getCategoryImpact(db.getDb(), arg);
        console.log(`\n── Category Impact: ${arg} ──\n`);
        console.log(`  Evidence count: ${result.evidenceCount}`);
        console.log(`  Proposals (${result.proposals.length}):`);
        for (const p of result.proposals) console.log(`    - ${p.id} [${p.status}] (${p.created_at})`);
        console.log(`  Rules (${result.rules.length}):`);
        for (const r of result.rules) console.log(`    - ${r.id} v${r.version} (${r.applied_at})`);
        break;
      }

      case 'rule-evolution': {
        if (!arg) { console.error('Missing familyId argument'); process.exit(1); }
        const result = getRuleEvolution(db.getDb(), arg);
        console.log(`\n── Rule Evolution: ${arg} ──\n`);
        console.log(`  Status: ${result.status}`);
        console.log(`  Versions (${result.versions.length}):`);
        for (const v of result.versions) {
          const rev = v.reverted_at ? ` (reverted ${v.reverted_at})` : '';
          console.log(`    v${v.version}: ${v.id} applied ${v.applied_at}${rev}`);
        }
        console.log(`  Related proposals: ${result.proposalIds.join(', ') || '(none)'}`);
        break;
      }

      case 'rule-effectiveness': {
        if (!arg) { console.error('Missing ruleId argument'); process.exit(1); }
        const result = getRuleEffectiveness(db.getDb(), arg);
        console.log(`\n── Rule Effectiveness: ${arg} ──\n`);
        if (result.before) {
          console.log(`  Before: ${(result.before.success_rate * 100).toFixed(1)}% (${result.before.window_start} ~ ${result.before.window_end})`);
        } else {
          console.log('  Before: (no snapshot)');
        }
        if (result.after) {
          console.log(`  After:  ${(result.after.success_rate * 100).toFixed(1)}% (${result.after.window_start} ~ ${result.after.window_end})`);
        } else {
          console.log('  After:  (no snapshot yet)');
        }
        if (result.delta !== null) {
          const sign = result.delta >= 0 ? '+' : '';
          console.log(`  Delta:  ${sign}${(result.delta * 100).toFixed(1)}pp`);
        } else {
          console.log('  Delta:  N/A');
        }
        break;
      }

      case 'snapshot': {
        if (!arg) { console.error('Missing category argument'); process.exit(1); }
        const total = parseInt(extra.total ?? '0', 10);
        const failures = parseInt(extra.failures ?? '0', 10);
        const start = extra.start ?? new Date().toISOString().slice(0, 10);
        const end = extra.end ?? new Date().toISOString().slice(0, 10);

        if (total <= 0) {
          console.error('--total must be > 0');
          process.exit(1);
        }

        const successRate = (total - failures) / total;
        db.insertSnapshot({
          category: arg,
          window_start: start,
          window_end: end,
          total_sessions: total,
          failure_count: failures,
          success_rate: successRate,
        });
        console.log(`Snapshot recorded: ${arg} ${(successRate * 100).toFixed(1)}% success (${total} sessions, ${failures} failures)`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
