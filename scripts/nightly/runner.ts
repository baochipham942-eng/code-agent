#!/usr/bin/env -S npx tsx
import { readFileSync, existsSync, mkdirSync, cpSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pipelineExitCode, inspectEvidence, parseCases, validateReport, type Row } from './contracts';
import { api, repo, expand, loadResident, runEmptyCase, save, schedulerProbe, scrub, startResident, stopResident } from './runtime';
import { captureReferencesAndFeedback, directory, renderReport, sendSummary } from './report';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stop') { await stopResident(loadResident(expand(args[0]))); console.log('STOPPED owned resident and caffeinate'); return; }
  if (existsSync(expand('~/.ship/disabled'))) throw new Error('FAIL emergency brake ~/.ship/disabled');
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const casesFile = expand(option('--cases') ?? '~/Downloads/ai/code-agent-private-archive/docs/features/context-health-compaction/cases.md');
  const specs = parseCases(readFileSync(casesFile, 'utf8'));
  if (command === 'start') { const state = await startResident(); console.log(`RESIDENT ${scrub(state.dataDir)} pid=${state.pid} port=${state.port}`); return; }
  if (command === 'schedule') {
    const state = loadResident(expand(args[0]));
    await schedulerProbe(state);
    const config = option('--notify-config');
    if (!config) throw new Error('FAIL schedule requires --notify-config');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const argv = [process.execPath, path.join(repo, 'node_modules/tsx/dist/cli.mjs'), path.join(repo, 'scripts/nightly/runner.ts'), 'run', '--scheduled', '--resident', state.dataDir, '--notify-config', expand(config)];
    const previousFile = path.join(state.dataDir, 'nightly-schedule.json');
    if (existsSync(previousFile)) throw new Error('FAIL nightly schedule already recorded; remove owned job before replacing');
    const job = await api(state, 'domain/cron/createJob', { payload: { name: 'nightly-acceptance', runsOn: 'local', enabled: true, scheduleType: 'cron', schedule: { type: 'cron', expression: option('--cron') ?? '0 3 * * *', timezone: 'Asia/Shanghai' }, action: { type: 'shell', command: argv.map(quote).join(' '), cwd: repo }, maxRetries: 0 } });
    save(previousFile, { jobId: job.id, schedule: job.schedule }); console.log(`SCHEDULED ${job.id}`); return;
  }
  if (command === 'report' || command === 'verify' || command === 'mutate') {
    const manifest = JSON.parse(readFileSync(expand(args[0]), 'utf8'));
    const rows: Row[] = manifest.rows;
    if (command === 'report') {
      const gateFile = option('--gates');
      const gates = gateFile ? readFileSync(expand(gateFile), 'utf8').trim().split('\n') : manifest.gates;
      if (!Array.isArray(gates)) throw new Error('FAIL manifest requires gates array or --gates file');
      const report = await renderReport(specs, rows, manifest.state, manifest.date, manifest.runId, gates, manifest.mechanism);
      const config = option('--notify-config');
      if (config) {
        const text = `Neo 夜跑：真跑 ${report.summary.executed} / 未执行 ${report.summary.skipped} / 失败 ${report.summary.failed} / 共55。验收包 ${scrub(report.html)}；新增 ${rows.flatMap(r => r.fbCreated ? [r.fb!] : []).join('、') || '无 FB'}；关联 ${rows.flatMap(r => r.fb ? [r.fb] : []).join('、') || '无 FB'}。`;
        save(path.join(path.dirname(report.html), `${manifest.date}-${manifest.runId}.notification.json`), sendSummary(config, text, manifest.runId));
      }
      console.log(`REPORT ${scrub(report.html)}`); return;
    }
    const dirFor = (r: Row) => directory(specs.find(c => c.id === r.id)!, r);
    if (command === 'verify') {
      const errors = validateReport(specs, rows, manifest.summary, dirFor);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(`REPORT_VALID ${JSON.stringify(manifest.summary)}`); return;
    }
    const blocked = rows.find(r => r.status === '未执行')!;
    blocked.status = '通过';
    const falseGreen = validateReport(specs, rows, manifest.summary, dirFor);
    if (!falseGreen.some(e => e.includes('COUNTS')) || !falseGreen.some(e => e.includes('blocked case'))) throw new Error('FAIL mutation 1 escaped');
    console.log(`MUTATION 1 caught\n${falseGreen.join('\n')}`);
    blocked.status = '未执行';
    const executed = rows.find(r => r.status !== '未执行' && r.frames.length);
    if (!executed) throw new Error('FAIL mutation 2 requires real screenshot evidence');
    const dir = path.join(expand(specs[0].root), 'mutations', manifest.runId, 'missing-screen');
    mkdirSync(dir, { recursive: true }); cpSync(dirFor(executed), dir, { recursive: true });
    unlinkSync(path.join(dir, `screens/${(executed.frames[1] ?? executed.frames[0])}.png`));
    const missing = inspectEvidence(executed, dir);
    if (!missing.some(e => e.includes('missing evidence screens/'))) throw new Error('FAIL mutation 2 escaped');
    console.log(`MUTATION 2 caught\n${missing.join('\n')}`);
    save(path.join(dir, 'mutation.json'), { rendering: '失败', errors: missing });
    console.log('MUTATION 3: run --fault-user-count 2 performs a new real run and files FB automatically'); return;
  }
  if (command !== 'run') throw new Error('Usage: runner.ts start | stop <dataDir> | run --resident <dataDir> [--notify-config <file>] [--fault-user-count 2] | verify <manifest> | mutate <manifest>');
  const date = option('--date') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('FAIL invalid date');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  let state = null;
  let mechanism: string | undefined;
  let probe;
  try {
    const resident = option('--resident');
    if (!resident) throw new Error('resident not specified');
    state = loadResident(expand(resident));
    probe = await schedulerProbe(state);
  } catch (error) { mechanism = `调度器未运行：${scrub(String(error))}`; console.error(`FAIL ${mechanism}`); }
  const rows: Row[] = [];
  const deliveryErrors: string[] = [];
  for (const spec of specs) {
    const reasons = [...spec.reasons, ...(mechanism ? [mechanism] : [])];
    if (reasons.length || !state) {
      rows.push({ id: spec.id, runId, status: '未执行', reasons, checks: [1, 2, 3].map(() => ({ status: '未执行', detail: reasons.join('；') })), files: {}, frames: [] });
      continue;
    }
    const dir = path.join(expand(spec.root), 'runs', spec.id, runId);
    const row = await runEmptyCase(spec, state, dir, runId, Number(option('--fault-user-count') ?? 1));
    save(path.join(dir, 'scheduler.json'), probe);
    const errors = await captureReferencesAndFeedback(row, dir, date, !!option('--fault-user-count'));
    deliveryErrors.push(...errors.map(error => `${row.id} ${error}`));
    for (const error of errors) console.error(`FAIL ${row.id} ${error}`);
    if (row.status === '未执行') console.log(`UNEXECUTED ${row.id} ${row.reasons.join('；')}`);
    if (row.status === '失败') { console.log(`FAIL ${row.id} ${row.checks.map((c, i) => `${i + 1}:${c.status} ${c.detail}`).join(' / ')} ${row.fb ?? 'FB未写入'}`); }
    rows.push(row);
  }
  const gateFile = option('--gates');
  const gates = gateFile ? readFileSync(expand(gateFile), 'utf8').trim().split('\n') : ['本机门：未附回执', 'PR 门：未运行', 'ai-review：未运行'];
  const deliveryFailure = deliveryErrors.length ? `流水线异常：${deliveryErrors.join('；')}` : undefined;
  const report = await renderReport(specs, rows, state, date, runId, gates, [mechanism, deliveryFailure].filter(Boolean).join('；') || undefined);
  const text = `Neo 夜跑：真跑 ${report.summary.executed} / 未执行 ${report.summary.skipped} / 失败 ${report.summary.failed} / 共55。验收包 ${scrub(report.html)}；新增 ${rows.flatMap(r => r.fbCreated ? [r.fb!] : []).join('、') || '无 FB'}；关联 ${rows.flatMap(r => r.fb ? [r.fb] : []).join('、') || '无 FB'}。`;
  const config = option('--notify-config');
  const summaryText = deliveryFailure ? `${text} ${deliveryFailure}` : text;
  if (config) save(path.join(path.dirname(report.html), `${date}-${runId}.notification.json`), sendSummary(config, summaryText, runId));
  else save(path.join(path.dirname(report.html), `${date}-${runId}.notification.json`), { status: '未发送', reason: '未配置已授权早报收件会话/profile/identity', text: summaryText });
  console.log(summaryText); console.log(`MANIFEST ${scrub(report.jsonFile)}`);
  const scheduled = args.includes('--scheduled');
  process.exitCode = pipelineExitCode({ executed: report.summary.executed, failed: report.summary.failed, mechanismFailed: !!mechanism || deliveryErrors.length > 0, notificationDelivered: !!config, scheduled });
  if (scheduled && process.exitCode === 0) console.log(`PIPELINE_COMPLETED acceptance=${report.summary.failed ? 'FAILED' : 'PARTIAL'} failed=${report.summary.failed} unexecuted=${report.summary.skipped}`);
}
main().catch(error => { console.error(scrub(String(error))); process.exitCode = 1; });
