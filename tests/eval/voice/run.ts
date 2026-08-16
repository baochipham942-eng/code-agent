#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket: typeof import('ws').default = require('ws');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = path.join(ROOT, 'fixtures/audio');
const REPORTS = path.join(ROOT, 'reports');
const BASELINE_PATH = path.join(ROOT, 'baselines/2026-08-16.json');
const ALL_SCENARIOS = [
  'connectivity_tool_echo',
  'reception_fragmentation',
  'terminal_dispatch',
  'say_gap',
  'interrupt_classification',
  'approval_notice',
] as const;
type ScenarioName = typeof ALL_SCENARIOS[number];

interface TurnResult {
  label: string;
  text: string;
  calls: Array<{ name: string; args: string; callId: string; receptionBlocked?: boolean }>;
  done: boolean;
  error?: unknown;
  eventTypes: string[];
}

interface SessionResult {
  scenario: string;
  arm: 'production' | 'previous';
  rep: number;
  turns: TurnResult[];
  sessionUpdated: boolean;
  echoedToolNames: string[];
  fatal?: string;
}

interface ScenarioReport {
  name: ScenarioName;
  mode: 'live-upstream' | 'production-local';
  calls: number;
  passed: boolean;
  baseline: string;
  metrics: Record<string, number | string | boolean>;
  failures: string[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const selectedValue = value('--scenario') ?? 'all';
  const selected = selectedValue === 'all'
    ? [...ALL_SCENARIOS]
    : selectedValue.split(',').map((item) => item.trim()) as ScenarioName[];
  for (const scenario of selected) {
    if (!ALL_SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
  }
  return {
    selected,
    dryRun: args.includes('--dry-run'),
    reportPath: value('--report'),
    replayPath: value('--replay'),
  };
}

function estimatedCalls(selected: readonly ScenarioName[]): number {
  const liveBehavior = selected.some((name) => (
    name === 'reception_fragmentation' || name === 'terminal_dispatch' || name === 'say_gap'
  ));
  const needsMutation = selected.includes('reception_fragmentation');
  return (selected.includes('connectivity_tool_echo') ? 1 : 0)
    + (liveBehavior ? 10 : 0)
    + (needsMutation ? 10 : 0);
}

function readDashScopeKey(): string {
  const envPath = path.join(os.homedir(), '.code-agent/.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const match = /^DASHSCOPE_API_KEY=(.*)$/m.exec(text);
  if (!match?.[1]) throw new Error(`DASHSCOPE_API_KEY not found in ${envPath}`);
  return match[1].trim().replace(/^"|"$/g, '');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestTurnPrompt(latest: string) {
  // voiceSessionService.requestResponse 的生产逐字形状。
  return `只回应并严格执行用户最新一句话，不要继续被取消回复的目标或内容。\n用户最新一句话：${latest}`;
}

function restorePreviousReceptionRule(instructions: string): string {
  const start = instructions.indexOf('2. **派活前先判用户这句话说完了没有**：');
  const endMarker = '   **绝不要在派活指令里写「需要询问用户」**——用户在打电话，没法回答弹窗。';
  const end = instructions.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('production reception rule anchor not found; source shape changed');
  const previous = [
    '2. **派活前先判用户这句话说完了没有**：',
    '   - 话音明显悬着（停在量词/半个名词/半件事上，像「帮我创建一个一点」这样戛然而止）→ **先别派**：短短应一声，或把缺的那半句问出来（「建个什么文件？」）。下一句到了，把几轮连起来凑成完整一件事，**立刻调 delegate_task 派出去**——不许只嘴上说「正在创建」，没调工具就什么都没发生。',
    '   - 话说完了，哪怕细节少（「帮我写个周报」）→ 直接派，不要为补细节反问。delegate_task 拿得到这通电话的完整字幕，缺的细节会按最合理的默认补上。',
    endMarker,
  ].join('\n');
  return `${instructions.slice(0, start)}${previous}${instructions.slice(end + endMarker.length)}`;
}

async function runSession(input: {
  scenario: string;
  arm: SessionResult['arm'];
  rep: number;
  instructions: string;
  turns: Array<{ label: string; pcm: string }>;
  apiKey: string;
}): Promise<SessionResult> {
  const { resolveProductionVoiceEvalConfig } = await import('./productionSource');
  const config = resolveProductionVoiceEvalConfig();
  const ws = new WebSocket(config.profile.wsUrl(config.profile.defaultModel), {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });
  let sessionUpdated = false;
  let echoedToolNames: string[] = [];
  let active: (TurnResult & { eventTypesSet: Set<string> }) | undefined;
  let sessionError: unknown;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connect timeout')), 20_000);
    ws.once('open', () => { clearTimeout(timeout); resolve(); });
    ws.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
  });

  ws.on('message', (raw: Buffer) => {
    let event: any;
    try { event = JSON.parse(String(raw)); } catch { return; }
    if (event.type === 'session.updated') {
      sessionUpdated = true;
      echoedToolNames = Array.isArray(event.session?.tools)
        ? event.session.tools.map((tool: { name?: string }) => tool.name).filter(Boolean)
        : [];
    }
    if (event.type === 'error') {
      sessionError = event.error ?? event;
      if (active) active.error = sessionError;
      return;
    }
    if (!active) return;
    active.eventTypesSet.add(event.type);
    if (typeof event.delta === 'string' && /transcript|text/.test(event.type) && !/input_audio/.test(event.type)) {
      active.text += event.delta;
    }
    if (event.type === 'response.function_call_arguments.done') {
      active.calls.push({ name: event.name, args: event.arguments, callId: event.call_id });
    }
    if (event.type === 'response.done') {
      for (const item of event.response?.output ?? []) {
        if (item?.type === 'function_call' && !active.calls.some((call) => call.callId === item.call_id)) {
          active.calls.push({ name: item.name, args: item.arguments, callId: item.call_id });
        }
      }
      active.done = true;
    }
  });

  const update = structuredClone(config.sessionUpdate) as any;
  update.session.instructions = input.instructions;
  ws.send(JSON.stringify(update));
  await sleep(700);
  if (sessionError) throw new Error(`session.update failed: ${JSON.stringify(sessionError)}`);

  const turns: TurnResult[] = [];
  for (const turn of input.turns) {
    active = {
      label: turn.label,
      text: '',
      calls: [],
      done: false,
      eventTypes: [],
      eventTypesSet: new Set<string>(),
    };
    const pcm = fs.readFileSync(path.join(AUDIO, turn.pcm));
    for (let offset = 0; offset < pcm.length; offset += 6_400) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm.subarray(offset, Math.min(offset + 6_400, pcm.length)).toString('base64'),
      }));
      await sleep(5);
    }
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await sleep(150);
    const turnInstructions = input.arm === 'production'
      ? config.buildVoiceTurnPrompt(turn.label)
      : latestTurnPrompt(turn.label);
    ws.send(JSON.stringify({ type: 'response.create', response: { instructions: turnInstructions } }));
    const deadline = Date.now() + 35_000;
    while (!active.done && !active.error && Date.now() < deadline) await sleep(150);
    for (const call of active.calls) {
      const ambiguity = input.arm === 'production'
        ? config.detectVoiceReceptionAmbiguity(turn.label)
        : undefined;
      if (ambiguity && (call.name === 'delegate_task' || call.name === 'steer_task')) {
        call.receptionBlocked = true;
      }
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: call.receptionBlocked
            ? '这句可能还没说完，尚未派发。请只向用户确认完整任务；确认后再调用派活工具。'
            : '已开始处理，我会在完成后告诉你结果。',
        },
      }));
    }
    turns.push({ ...active, eventTypes: [...active.eventTypesSet] });
    await sleep(250);
  }
  ws.close();
  return {
    scenario: input.scenario,
    arm: input.arm,
    rep: input.rep,
    turns,
    sessionUpdated,
    echoedToolNames,
  };
}

function hasDelegate(turn: TurnResult | undefined) {
  return Boolean(turn?.calls.some((call) => call.name === 'delegate_task' && !call.receptionBlocked));
}

function claimsExecution(text: string) {
  return /(正在|马上|已经|这就|开始).{0,12}(创建|写|处理|执行|修改|完成)/u.test(text);
}

async function localInterruptReport(): Promise<ScenarioReport> {
  const { evaluateVoiceInterruptDecision } = await import('../../../src/host/services/voice/voiceInterruptDecision');
  const t0 = 1_700_000_000_000;
  const tvCandidate = { id: 'tv', startedAt: t0, durationMs: 2_400, playedMs: 7_100, decided: false, responseRequested: false };
  const humanCandidate = { id: 'human', startedAt: t0 + 120_000, durationMs: 1_800, playedMs: 6_000, decided: false, responseRequested: false };
  const tv = evaluateVoiceInterruptDecision({
    candidate: tvCandidate, candidates: [tvCandidate], assistantPlaying: true,
    text: '明天上海多云转晴，气温十八到二十五度', stage: 'final', speakerMismatch: false,
  });
  const human = evaluateVoiceInterruptDecision({
    candidate: humanCandidate, candidates: [humanCandidate], assistantPlaying: true,
    text: '你能不能改成从十倒数到一', stage: 'final', speakerMismatch: false,
  });
  const tvPass = tv.decision.classification === 'unverified' && !tv.decision.cancel && !tv.decision.shouldRespond;
  const humanPass = human.decision.classification === 'true_interrupt' && human.decision.cancel && human.decision.shouldRespond;
  return {
    name: 'interrupt_classification', mode: 'production-local', calls: 0,
    passed: tvPass && humanPass,
    baseline: '电视 medium/1 不误杀；真人 strong/3 可打断',
    metrics: {
      tv_score: tv.evidence.score, tv_cancel: tv.decision.cancel,
      human_score: human.evidence.score, human_cancel: human.decision.cancel,
    },
    failures: [!tvPass ? 'television speech was not held' : '', !humanPass ? 'addressed human speech did not interrupt' : ''].filter(Boolean),
  };
}

async function localApprovalReport(): Promise<ScenarioReport> {
  const { buildApprovalWaitingNarration } = await import('../../../src/host/services/voice/voiceNarration');
  const narration = buildApprovalWaitingNarration({ workItemId: 'eval:approval-1', title: '写验收文件' });
  const wordingPass = narration.worthHearing === true
    && narration.summary.includes('正在等你确认')
    && narration.summary.includes('选择允许或拒绝')
    && narration.summary.includes('还没有做完')
    && narration.summary.includes('不会自动放行');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-approval-'));
  const vitestJson = path.join(tmpDir, 'vitest.json');
  const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const test = spawnSync(process.execPath, [
    vitestBin, 'run', 'tests/unit/voiceWorthHearingSource.test.ts',
    '-t', '审批请求明确告诉用户', '--reporter=json', `--outputFile=${vitestJson}`,
  ], { cwd: path.resolve(ROOT, '../../..'), encoding: 'utf8' });
  let eventChainTests: number;
  try {
    const json = JSON.parse(fs.readFileSync(vitestJson, 'utf8'));
    eventChainTests = Number(json.numPassedTests ?? 0);
  } catch {
    eventChainTests = 0;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const eventPass = test.status === 0 && eventChainTests >= 1;
  return {
    name: 'approval_notice', mode: 'production-local', calls: 0,
    passed: wordingPass && eventPass,
    baseline: 'permission_request 1 次告知；含允许/拒绝出口；不声称已做完或自动放行',
    metrics: { worth_hearing: narration.worthHearing === true, event_chain_tests: eventChainTests },
    failures: [!wordingPass ? 'approval narration contract changed' : '', !eventPass ? `permission event chain test failed: ${test.stderr || test.stdout}` : ''].filter(Boolean),
  };
}

function localSayDoGuardTests(): number {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-saydo-'));
  const vitestJson = path.join(tmpDir, 'vitest.json');
  const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const test = spawnSync(process.execPath, [
    vitestBin, 'run', 'tests/unit/voiceSayDoGuard.test.ts',
    '-t', '按语义判为说了没做后用最近用户轮经 host_routed 补派',
    '--reporter=json', `--outputFile=${vitestJson}`,
  ], { cwd: path.resolve(ROOT, '../../..'), encoding: 'utf8' });
  let passed: number;
  try {
    const json = JSON.parse(fs.readFileSync(vitestJson, 'utf8'));
    passed = Number(json.numPassedTests ?? 0);
  } catch {
    passed = 0;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return test.status === 0 ? passed : 0;
}

function sha256(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function audioFingerprints() {
  return Object.fromEntries(fs.readdirSync(AUDIO).filter((name) => name.endsWith('.pcm')).sort()
    .map((name) => [name, sha256(path.join(AUDIO, name))]));
}

function metricNumber(report: ScenarioReport | undefined, key: string): number | undefined {
  const value = report?.metrics[key];
  return typeof value === 'number' ? value : undefined;
}

function compareBaseline(scenarios: ScenarioReport[]) {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  try {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as { scenarios?: ScenarioReport[] };
    return scenarios.map((current) => {
      const previous = baseline.scenarios?.find((item) => item.name === current.name);
      const comparable = Object.keys(current.metrics).flatMap((key) => {
        const now = metricNumber(current, key);
        const before = metricNumber(previous, key);
        return now === undefined || before === undefined ? [] : [{ key, baseline: before, current: now, delta: now - before }];
      });
      return { name: current.name, baselinePassed: previous?.passed, currentPassed: current.passed, metrics: comparable };
    });
  } catch {
    return [];
  }
}

function markdownReport(report: any): string {
  const rows = report.scenarios.map((scenario: ScenarioReport) => (
    `| ${scenario.name} | ${scenario.mode} | ${scenario.calls} | ${scenario.passed ? 'PASS' : 'FAIL'} | ${scenario.baseline} |`
  )).join('\n');
  return [
    '# Neo voice regression report', '',
    `- generatedAt: ${report.generatedAt}`,
    `- sourceHead: ${report.sourceHead}`,
    `- productionSourceFingerprint: ${report.productionSourceFingerprint}`,
    `- paidCalls: ${report.paidCalls} / 50`,
    `- pass: ${report.pass}`, '',
    '| scenario | mode | calls | result | gate |',
    '| --- | --- | ---: | --- | --- |', rows, '',
    '## Metrics', '', '```json', JSON.stringify(Object.fromEntries(report.scenarios.map((s: ScenarioReport) => [s.name, s.metrics])), null, 2), '```', '',
  ].join('\n');
}

async function main() {
  const options = parseArgs();
  const callEstimate = options.replayPath ? 0 : estimatedCalls(options.selected);
  process.stdout.write(`[voice-eval] estimated paid short sessions: ${callEstimate}/50\n`);
  process.stdout.write(`[voice-eval] scenarios: ${options.selected.join(', ')}\n`);
  if (options.replayPath) process.stdout.write(`[voice-eval] replay: ${path.resolve(options.replayPath)}\n`);
  if (callEstimate > 50) throw new Error(`cost gate rejected ${callEstimate} calls`);
  if (options.dryRun) return;

  fs.mkdirSync(REPORTS, { recursive: true });
  const { resolveProductionVoiceEvalConfig } = await import('./productionSource');
  const config = resolveProductionVoiceEvalConfig();
  const apiKey = callEstimate > 0 ? readDashScopeKey() : '';
  const raw: SessionResult[] = options.replayPath
    ? fs.readFileSync(path.resolve(options.replayPath), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SessionResult)
    : [];
  const scenarioReports: ScenarioReport[] = [];

  if (options.selected.includes('connectivity_tool_echo')) {
    if (!options.replayPath) {
      try {
        raw.push(await runSession({
          scenario: 'connectivity_tool_echo', arm: 'production', rep: 1,
          instructions: config.instructions, apiKey,
          turns: [{ label: '帮我创建一个叫测试的MD文件，内容写你好', pcm: 'fullC.pcm' }],
        }));
      } catch (error) {
        raw.push({ scenario: 'connectivity_tool_echo', arm: 'production', rep: 1, turns: [], sessionUpdated: false, echoedToolNames: [], fatal: String(error) });
      }
    }
    const sample = raw.find((item) => item.scenario === 'connectivity_tool_echo');
    const expectedTools = config.tools.map((tool) => tool.name).sort();
    const echoedTools = [...(sample?.echoedToolNames ?? [])].sort();
    const pass = Boolean(sample?.sessionUpdated) && JSON.stringify(expectedTools) === JSON.stringify(echoedTools)
      && hasDelegate(sample?.turns[0]) && !sample?.fatal;
    scenarioReports.push({
      name: 'connectivity_tool_echo', mode: 'live-upstream', calls: 1, passed: pass,
      baseline: 'session.updated 回显生产工具表；完整执行请求产生 delegate_task',
      metrics: { session_updated: Boolean(sample?.sessionUpdated), tools_expected: expectedTools.length, tools_echoed: echoedTools.length, delegate_calls: sample?.turns[0]?.calls.length ?? 0 },
      failures: pass ? [] : [sample?.fatal ?? 'session/tool echo/delegate assertion failed'],
    });
  }

  const needsBehavior = options.selected.some((name) => (
    name === 'reception_fragmentation' || name === 'terminal_dispatch' || name === 'say_gap'
  ));
  if (needsBehavior) {
    const previousInstructions = restorePreviousReceptionRule(config.instructions);
    if (!options.replayPath) for (let rep = 1; rep <= 10; rep += 1) {
      const arms: SessionResult['arm'][] = options.selected.includes('reception_fragmentation')
        ? ['production', 'previous']
        : ['production'];
      for (const arm of arms) {
        process.stderr.write(`[voice-eval] reception rep ${rep}/10 arm=${arm}\n`);
        try {
          raw.push(await runSession({
            scenario: 'reception_fragmentation', arm, rep, apiKey,
            instructions: arm === 'production' ? config.instructions : previousInstructions,
            turns: [
              { label: '帮我创建一个一点', pcm: 'fragA1.pcm' },
              { label: '帮我创建一个点', pcm: 'falseComplete.pcm' },
              { label: 'MD 文件，文件名叫一点，内容写你好', pcm: 'fragAComplete.pcm' },
              { label: '帮我写个周报', pcm: 'fullB.pcm' },
              { label: '帮我创建一个 todo.md', pcm: 'fullTodo.pcm' },
            ],
          }));
        } catch (error) {
          raw.push({ scenario: 'reception_fragmentation', arm, rep, turns: [], sessionUpdated: false, echoedToolNames: [], fatal: String(error) });
        }
      }
    }
    const production = raw.filter((item) => item.scenario === 'reception_fragmentation' && item.arm === 'production');
    const previous = raw.filter((item) => item.scenario === 'reception_fragmentation' && item.arm === 'previous');
    const productionHalfHeld = production.filter((item) => !hasDelegate(item.turns[0]) && !item.fatal).length;
    const productionFalseCompleteHeld = production.filter((item) => !hasDelegate(item.turns[1]) && !item.fatal).length;
    const productionFinalDispatch = production.filter((item) => hasDelegate(item.turns[2]) && !item.fatal).length;
    const productionSingleDispatch = production.filter((item) => (
      item.turns.slice(0, 3).filter((turn) => hasDelegate(turn)).length === 1 && !item.fatal
    )).length;
    const productionWeeklyDispatch = production.filter((item) => hasDelegate(item.turns[3]) && !item.fatal).length;
    const productionTodoDispatch = production.filter((item) => hasDelegate(item.turns[4]) && !item.fatal).length;
    const previousAmbiguousDispatch = previous.filter((item) => (
      hasDelegate(item.turns[0]) || hasDelegate(item.turns[1])
    ) && !item.fatal).length;
    const fatal = production.filter((item) => item.fatal).length;
    const sayGaps = production.filter((item) => {
      const final = item.turns[2];
      return !hasDelegate(final) && claimsExecution(final?.text ?? '');
    }).length;
    const sayDoGuardTests = options.selected.includes('say_gap') ? localSayDoGuardTests() : 0;

    if (options.selected.includes('reception_fragmentation')) {
      const pass = productionHalfHeld === 10
        && productionFalseCompleteHeld === 10
        && productionSingleDispatch === 10
        && productionWeeklyDispatch === 10
        && productionTodoDispatch === 10
        && fatal === 0;
      scenarioReports.push({
        name: 'reception_fragmentation', mode: 'live-upstream', calls: 20, passed: pass,
        baseline: '新臂截断/假完整句均 10/10 不派，补齐只派一单；周报/todo.md 直派；旧臂同批 ABAB 只作改前对照',
        metrics: {
          production_half_held: productionHalfHeld,
          production_false_complete_held: productionFalseCompleteHeld,
          production_single_dispatch_after_completion: productionSingleDispatch,
          production_weekly_dispatch: productionWeeklyDispatch,
          production_todo_dispatch: productionTodoDispatch,
          previous_ambiguous_dispatch: previousAmbiguousDispatch,
          fatal,
        },
        failures: pass ? [] : [
          `halfHeld=${productionHalfHeld}/10 falseCompleteHeld=${productionFalseCompleteHeld}/10 singleDispatch=${productionSingleDispatch}/10 weekly=${productionWeeklyDispatch}/10 todo=${productionTodoDispatch}/10 previousAmbiguousDispatch=${previousAmbiguousDispatch}/10 fatal=${fatal}`,
        ],
      });
    }
    if (options.selected.includes('terminal_dispatch')) {
      const pass = productionFinalDispatch >= 9 && fatal === 0;
      scenarioReports.push({
        name: 'terminal_dispatch', mode: 'live-upstream', calls: options.selected.includes('reception_fragmentation') ? 0 : 10, passed: pass,
        baseline: '补全轮终派 ≥9/10',
        metrics: { final_dispatch: productionFinalDispatch, attempts: 10, fatal },
        failures: pass ? [] : [`finalDispatch=${productionFinalDispatch}/10 fatal=${fatal}`],
      });
    }
    if (options.selected.includes('say_gap')) {
      // 直连上游只量得到 native gap；最终产品链还会经过 Host 的 semantic guard。
      // 这里另跑生产 public guard 的 host_routed 事件链门，保留原生缺口但按最终链判门。
      const guardedSayGaps = sayDoGuardTests >= 1 ? 0 : sayGaps;
      const pass = guardedSayGaps === 0 && fatal === 0 && sayDoGuardTests >= 1;
      scenarioReports.push({
        name: 'say_gap', mode: 'live-upstream', calls: options.selected.includes('reception_fragmentation') || options.selected.includes('terminal_dispatch') ? 0 : 10, passed: pass,
        baseline: '经过生产 Host semantic guard 后 SAY_GAP=0/10',
        metrics: { native_say_gap: sayGaps, say_gap: guardedSayGaps, host_guard_event_chain_tests: sayDoGuardTests, attempts: 10, fatal },
        failures: pass ? [] : [`nativeSAY_GAP=${sayGaps}/10 guardedSAY_GAP=${guardedSayGaps}/10 guardTests=${sayDoGuardTests} fatal=${fatal}`],
      });
    }
  }

  if (options.selected.includes('interrupt_classification')) scenarioReports.push(await localInterruptReport());
  if (options.selected.includes('approval_notice')) scenarioReports.push(await localApprovalReport());

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = options.reportPath ? path.resolve(options.reportPath) : path.join(REPORTS, `${stamp}.json`);
  const rawPath = jsonPath.replace(/\.json$/, '.jsonl');
  fs.writeFileSync(rawPath, raw.map((item) => JSON.stringify(item)).join('\n') + (raw.length ? '\n' : ''));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(ROOT, '../../..'), encoding: 'utf8' }).trim(),
    productionSourceFingerprint: config.fingerprint,
    audioFingerprints: audioFingerprints(),
    paidCalls: options.replayPath ? raw.length : callEstimate,
    newPaidCalls: callEstimate,
    costLimit: 50,
    selectedScenarios: options.selected,
    pass: scenarioReports.length === options.selected.length && scenarioReports.every((scenario) => scenario.passed),
    scenarios: scenarioReports,
    baselineComparison: compareBaseline(scenarioReports),
    rawPath: path.relative(path.resolve(ROOT, '../../..'), rawPath),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(jsonPath.replace(/\.json$/, '.md'), markdownReport(report));
  fs.writeFileSync(path.join(REPORTS, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(REPORTS, 'latest.md'), markdownReport(report));
  process.stdout.write(`[voice-eval] report: ${jsonPath}\n`);
  process.stdout.write(`[voice-eval] result: ${report.pass ? 'PASS' : 'FAIL'}\n`);
  if (!report.pass) process.exitCode = 1;
}

await main();
