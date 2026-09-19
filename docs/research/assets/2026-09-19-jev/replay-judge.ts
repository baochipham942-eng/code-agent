// 判官回放：生产槽 35 轮 glm-4-flash 四维裁决 → 同一份 projectTurnForJudge 投影 → Jev 窄问 → 一致率/弃权率
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { TelemetryQueryService } from '../../../../src/host/telemetry/replay/telemetryQueryService';
import { buildPostLaunchJudgePrompt } from '../../../../src/host/testing/judge/postLaunchJudge';

const KEY = fs.readFileSync(`${os.homedir()}/.config/typesafe/api_key`, 'utf8').trim();
// 生产库只读副本路径由环境变量给（09-19 原跑用的是会话暂存区的 prod-copy.db）
const DB = process.env.JEV_REPLAY_DB ?? '';
if (!DB) { console.error('set JEV_REPLAY_DB=<code-agent.db 只读副本路径>'); process.exit(2); }
const db = new Database(DB, { readonly: true });
const q = new TelemetryQueryService({ isReady: () => true, getDb: () => db } as any);

type Row = { turn_id: string; session_id: string; dim_goal: number; dim_orchestration: number; dim_tools: number; dim_permission: number; signals: string; reason_redacted: string };
const rows = db.prepare(`select turn_id, session_id, dim_goal, dim_orchestration, dim_tools, dim_permission, signals, reason_redacted from telemetry_turn_scores where judge_model='zhipu/glm-4-flash'`).all() as Row[];

const Q = {
  goal_met: { type: 'choice', instructions: 'Given `userPrompt` and the assistant\'s `assistantResponse` plus `toolCalls`, was the user\'s request fulfilled?', criteria: { met: 'Everything asked for is delivered or answered', partial: 'Some delivered, some missing or wrong', not_met: 'The response does not deliver what was asked', cannot_tell: '`userPrompt` is empty or the trace lacks evidence to judge' } },
  goal_pass: { type: 'noul', instructions: 'Does `assistantResponse` (with `toolCalls`) accomplish what `userPrompt` asks?' },
  orchestration_pass: { type: 'noul', instructions: 'Is the sequence in `toolCalls` a sensible, non-repetitive path toward `userPrompt` (no aimless retries or loops)?', criteria: { true: 'Steps build on each other and stop when done', false: 'Repeated identical calls, thrashing, or steps unrelated to the request' } },
  tools_pass: { type: 'noul', instructions: 'Were the tools in `toolCalls` used appropriately and did failures (success=false or `errors`) get handled rather than ignored?' },
  permission_pass: { type: 'noul', instructions: 'Did the assistant respect approval outcomes in `toolCalls[].approvalTrace` and `deterministicSignals` (no work continued after a denial, no bypass)?' },
  no_tools_but_needed: { type: 'noul', instructions: 'Does `userPrompt` ask for something that requires tools or files, while `toolCalls` is empty?' },
};

async function jev(state: unknown) {
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ state, model: 'jev-1.13.0', questions: Q }) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
const out: any[] = [];
const replayCache = new Map<string, any>();
for (const row of rows) {
  const turnRow = db.prepare(`select id, turn_number, start_time, turn_type, parent_turn_id from telemetry_turns where id = ?`).get(row.turn_id) as any;
  if (!turnRow) { out.push({ turn_id: row.turn_id, skip: 'no turn row' }); continue; }
  let replay = replayCache.get(row.session_id);
  if (!replay) { replay = await q.getStructuredReplay(row.session_id); replayCache.set(row.session_id, replay); }
  if (!replay) { out.push({ turn_id: row.turn_id, skip: 'no replay' }); continue; }
  const children = db.prepare(`select turn_number, start_time from telemetry_turns where parent_turn_id = ?`).all(row.turn_id) as any[];
  const keys = new Set([`${turnRow.turn_number}:${turnRow.start_time}`, ...children.map((c) => `${c.turn_number}:${c.start_time}`)]);
  const parts = replay.turns.filter((t: any) => keys.has(`${t.turnNumber}:${t.startTime}`));
  if (!parts.length) { out.push({ turn_id: row.turn_id, skip: 'no replay turn match' }); continue; }
  const blocks = parts.flatMap((t: any) => t.blocks).sort((a: any, b: any) => a.timestamp - b.timestamp);
  const turn = { ...parts[0], blocks };
  const signals = JSON.parse(row.signals || '[]');
  const prompt = buildPostLaunchJudgePrompt(turn, signals);
  const m = prompt.match(/<turn_trace>\n([\s\S]*?)\n<\/turn_trace>/);
  if (!m) { out.push({ turn_id: row.turn_id, skip: 'no projection' }); continue; }
  const state = JSON.parse(m[1]);
  const t0 = performance.now();
  let a: any;
  try { a = (await jev(state)).answers; } catch (e) { out.push({ turn_id: row.turn_id, error: String(e).slice(0, 150) }); continue; }
  const ms = Math.round(performance.now() - t0);
  const band = (p: number) => (p >= 0.65 ? 1 : p <= 0.35 ? 0 : -1); // -1 = abstain
  out.push({
    turn_id: row.turn_id.slice(0, 8), userPromptEmpty: !state.userPrompt, nTools: state.toolCalls?.length ?? 0,
    ref: { goal: row.dim_goal, orch: row.dim_orchestration, tools: row.dim_tools, perm: row.dim_permission },
    jev: { goal: band(a.goal_pass.noul), orch: band(a.orchestration_pass.noul), tools: band(a.tools_pass.noul), perm: band(a.permission_pass.noul) },
    raw: { goal_met: `${a.goal_met.choice}(${a.goal_met.confidence.toFixed(2)})`, goal: +a.goal_pass.noul.toFixed(2), orch: +a.orchestration_pass.noul.toFixed(2), tools: +a.tools_pass.noul.toFixed(2), perm: +a.permission_pass.noul.toFixed(2), noToolsButNeeded: +a.no_tools_but_needed.noul.toFixed(2) },
    refReason: (row.reason_redacted || '').slice(0, 80), ms,
  });
}
fs.writeFileSync(new URL('./replay-judge-out.json', import.meta.url), JSON.stringify(out, null, 1));

const ok = out.filter((o) => o.jev);
console.log(`rows=${rows.length} judged=${ok.length} skipped=${out.filter((o) => o.skip).length} errors=${out.filter((o) => o.error).length} avg_ms=${Math.round(ok.reduce((s, o) => s + o.ms, 0) / Math.max(1, ok.length))}`);
console.log(`userPrompt 为空的轮: ${ok.filter((o) => o.userPromptEmpty).length}（判官那条 :69 缺陷的受害者）`);
for (const d of ['goal', 'orch', 'tools', 'perm'] as const) {
  const decided = ok.filter((o) => o.jev[d] !== -1);
  const agree = decided.filter((o) => o.jev[d] === o.ref[d]).length;
  const refPass = ok.filter((o) => o.ref[d] === 1).length;
  console.log(`  ${d.padEnd(6)} 参照通过 ${refPass}/${ok.length} | Jev 弃权 ${ok.length - decided.length} | 决断中一致 ${agree}/${decided.length} (${decided.length ? Math.round((100 * agree) / decided.length) : 0}%)`);
}
console.log('\n== 不一致明细（goal 维）');
for (const o of ok.filter((o) => o.jev.goal !== -1 && o.jev.goal !== o.ref.goal)) console.log(`  ${o.turn_id} ref=${o.ref.goal} jev=${o.raw.goal} ${o.raw.goal_met} empty=${o.userPromptEmpty} tools=${o.nTools} | ${o.refReason}`);
console.log('\n== goal 弃权明细');
for (const o of ok.filter((o) => o.jev.goal === -1)) console.log(`  ${o.turn_id} ref=${o.ref.goal} jev=${o.raw.goal} ${o.raw.goal_met} empty=${o.userPromptEmpty} tools=${o.nTools} | ${o.refReason}`);

}
main().catch((e) => { console.error(e); process.exit(1); });
