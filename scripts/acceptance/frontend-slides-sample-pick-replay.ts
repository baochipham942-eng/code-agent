// ============================================================================
// N-PPT-SAMPLE-PICK-FLOW — real-model replay of the frontend-slides sample-pick step.
// Feeds the packaged SKILL.md to GLM (subscription tier) as the system prompt with
// stubbed ask_user_question and real bash/write_file, then asserts on the final PPTX.
//
//   npx tsx scripts/acceptance/frontend-slides-sample-pick-replay.ts <pick|direct|nolo>
//
// pick   : "8-page quarterly report" -> 3 sample images -> scripted "option 2" -> deck
// direct : same request + "直接做"      -> no sample step -> deck
// nolo   : like pick, but LibreOffice is hidden from bash -> text option menu -> option 2
// Transcript lands in ~/work/out/N-PPT-SAMPLE-PICK-FLOW/<scenario>.transcript.txt
// ============================================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

type Scenario = 'pick' | 'direct' | 'nolo';
interface ToolCall { id: string; function: { name: string; arguments: string } }
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const THEME_FACTS: Record<string, { font: string; background: string }> = {
  corporate: { font: 'Microsoft YaHei', background: 'F8FAFC' },
  minimal: { font: 'PingFang SC', background: 'FFFFFF' },
  'bold-editorial': { font: 'Songti SC', background: '111111' },
};
const MAX_TURNS = 30;
const REQUEST_TIMEOUT_MS = 240_000;
const BASH_TIMEOUT_MS = 300_000;

const scenario = process.argv[2] as Scenario;
if (!['pick', 'direct', 'nolo'].includes(scenario)) {
  console.error('usage: frontend-slides-sample-pick-replay.ts <pick|direct|nolo>');
  process.exit(1);
}

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const skillDir = path.join(repo, 'resources', 'skills', 'frontend-slides');
const outDir = path.join(os.homedir(), 'work', 'out', 'N-PPT-SAMPLE-PICK-FLOW');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), `fs-replay-${scenario}-`));
const transcriptPath = path.join(outDir, `${scenario}.transcript.txt`);
fs.writeFileSync(transcriptPath, '');
const transcript = (line: string): void => {
  fs.appendFileSync(transcriptPath, `${line}\n`);
  console.log(line);
};

function loadKey(): string {
  const env = fs.readFileSync(path.join(os.homedir(), '.code-agent', '.env'), 'utf8');
  const match = env.match(/^ZHIPU_CODING_API_KEY=(.*)$/m);
  const key = match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!key) throw new Error('ZHIPU_CODING_API_KEY missing in ~/.code-agent/.env');
  return key;
}

const userRequest = scenario === 'direct'
  ? 'Make an 8-page quarterly report on Q3 sales: revenue +23% YoY, new customers 41% of orders, regions East/South/Overseas. 直接做.'
  : 'Make an 8-page quarterly report on Q3 sales: revenue +23% YoY, new customers 41% of orders, regions East/South/Overseas.';

// bash PATH: node via symlink only; for nolo LibreOffice is hidden (PATH stripped + explicit override).
const binDir = path.join(work, '_bin');
fs.mkdirSync(binDir);
fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
const bashEnv: NodeJS.ProcessEnv = {
  HOME: os.homedir(),
  PATH: `${binDir}:/usr/bin:/bin`,
  SKILL_DIR: path.join(skillDir, 'scripts', '..'),
  ...(scenario === 'nolo' ? { LIBREOFFICE_PATH: path.join(work, 'no-soffice') } : {}),
};
if (scenario !== 'nolo') bashEnv.PATH = `${binDir}:/opt/homebrew/bin:/usr/bin:/bin`;

const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').replace('$ARGUMENTS', userRequest);
const system = `${skill}\n\n---\n运行环境：工作目录 ${work}；SKILL_DIR=${bashEnv.SKILL_DIR}（bash 环境里已设为环境变量）。可用工具只有 bash、write_file、ask_user_question；没有 image_generate。`;

const tools = [
  { type: 'function', function: { name: 'bash', description: 'Run a shell command in the working directory.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a UTF-8 file (path relative to the working directory or absolute).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'ask_user_question', description: 'Ask the user to choose among 2-4 options.', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } } }, required: ['question', 'options'] } } },
];

let askedCount = 0;
let pickedLabel = '';
function execTool(call: ToolCall): string {
  let args: Record<string, unknown>;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return 'error: arguments are not valid JSON'; }
  const name = call.function.name;
  if (name === 'bash') {
    const result = spawnSync('bash', ['-c', String(args.command ?? '')], { cwd: work, env: bashEnv, encoding: 'utf8', timeout: BASH_TIMEOUT_MS });
    return `exit=${result.status}\n${(result.stdout ?? '').slice(-6000)}${result.stderr ? `\n[stderr]\n${result.stderr.slice(-3000)}` : ''}`;
  }
  if (name === 'write_file') {
    const target = path.resolve(work, String(args.path ?? ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(args.content ?? ''));
    return `wrote ${target}`;
  }
  if (name === 'ask_user_question') {
    askedCount += 1;
    const options = Array.isArray(args.options) ? (args.options as Array<{ label?: string }>) : [];
    // Scripted answer: "option 2" (direct scenario never expects a question; answer the same so the run can proceed).
    pickedLabel = String(options[1]?.label ?? '');
    return `User selected option 2: ${pickedLabel}`;
  }
  return `error: unknown tool ${name}`;
}

async function chat(messages: ChatMessage[], key: string): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const response = await fetch(`${ZHIPU_CODING_TIER.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: ZHIPU_CODING_TIER.model, messages, tools, temperature: 0.3 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`model HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const json = (await response.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }> };
  return json.choices[0].message;
}

function findDeckPptx(): string | null {
  const root = path.join(work, 'slide-deck');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const pptx = fs.readdirSync(full).find((f) => f.endsWith('.pptx'));
    if (pptx) return path.join(full, pptx);
  }
  return null;
}

function unzipText(pptx: string, entry: string): string {
  return spawnSync('unzip', ['-p', pptx, entry], { encoding: 'utf8' }).stdout;
}

async function main(): Promise<void> {
  const key = loadKey();
  transcript(`# scenario=${scenario} model=${ZHIPU_CODING_TIER.model} work=${work}`);
  transcript(`## USER\n${userRequest}`);
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: userRequest }];
  const assistantTexts: string[] = [];
  const bashCommands: string[] = [];
  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const reply = await chat(messages, key);
    messages.push({ role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) });
    if (reply.content) {
      assistantTexts.push(reply.content);
      transcript(`## ASSISTANT (turn ${turn})\n${reply.content}`);
    }
    if (!reply.tool_calls?.length) break;
    for (const call of reply.tool_calls) {
      const shown = call.function.arguments.length > 1500 ? `${call.function.arguments.slice(0, 1500)}…[truncated]` : call.function.arguments;
      transcript(`## TOOL_CALL ${call.function.name} ${shown}`);
      if (call.function.name === 'bash') bashCommands.push(String((JSON.parse(call.function.arguments || '{}') as { command?: string }).command ?? ''));
      const output = execTool(call);
      transcript(`## TOOL_RESULT\n${output.slice(0, 2500)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  // ---- assertions ----
  const checks: Array<[string, boolean]> = [];
  const allText = assistantTexts.join('\n');
  const imageLinks = [...allText.matchAll(/!\[[^\]]*\]\(([^)]+\.png)\)/g)].map((m) => m[1]);
  // Executed, not merely read: `node …/theme-samples.mjs`.
  const sampleStep = bashCommands.some((c) => /node\s+\S*theme-samples\.mjs/.test(c));
  const pptx = findDeckPptx();
  transcript(`## ASSERTIONS\nask_user_question calls=${askedCount} pickedLabel=${pickedLabel || '-'} sampleScriptRun=${sampleStep} imageLinks=${imageLinks.length} pptx=${pptx ?? 'none'}`);
  checks.push(['deck pptx exists', Boolean(pptx)]);
  if (scenario === 'direct') {
    checks.push(['no sample step (theme-samples.mjs never executed)', !sampleStep]);
    checks.push(['no sample images shown', imageLinks.length === 0]);
  } else {
    checks.push(['sample script executed', sampleStep]);
    if (scenario === 'pick') {
      checks.push(['samples shown as 3 markdown image links', imageLinks.length >= 3]);
      checks.push(['sample PNG files exist and are non-empty', imageLinks.slice(0, 3).every((p) => fs.existsSync(p) && fs.statSync(p).size > 0)]);
    } else {
      checks.push(['script reported available:false', JSON.stringify(messages).includes('\\"available\\":false')]);
      checks.push(['no sample images shown without LibreOffice', imageLinks.length === 0]);
      checks.push(['reply says there is no preview on this machine', /没有预览|no preview/i.test(allText + JSON.stringify(messages))]);
    }
    checks.push(['user was asked exactly via ask_user_question', askedCount >= 1]);
    if (scenario === 'nolo') {
      checks.push(['text menu mentions palette+font per theme', ['F8FAFC', 'FFFFFF', '111111'].every((c) => JSON.stringify(messages).includes(c)) && ['Microsoft YaHei', 'PingFang SC', 'Songti SC'].every((f) => JSON.stringify(messages).includes(f))]);
    }
  }
  if (pptx) {
    const slideCount = spawnSync('unzip', ['-Z1', pptx], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /^ppt\/slides\/slide\d+\.xml$/.test(l)).length;
    checks.push(['8 slides', slideCount === 8]);
    const themeOf = (xml: string): string | undefined =>
      Object.entries(THEME_FACTS).find(([, t]) => xml.includes(`typeface="${t.font}"`) && xml.includes(`srgbClr val="${t.background}"`))?.[0];
    const perSlide = Array.from({ length: slideCount }, (_, i) => themeOf(unzipText(pptx, `ppt/slides/slide${i + 1}.xml`)));
    transcript(`per-slide theme: ${JSON.stringify(perSlide)}`);
    const expected = scenario === 'direct' ? perSlide[0] : pickedLabel;
    checks.push([`all slides use one named theme (${expected ?? 'none'})`, Boolean(expected) && perSlide.every((t) => t === expected)]);
    if (expected && THEME_FACTS[expected]) {
      const sample = unzipText(pptx, 'ppt/slides/slide2.xml');
      transcript(`slide2 XML assertions: typeface="${THEME_FACTS[expected].font}" -> ${sample.includes(`typeface="${THEME_FACTS[expected].font}"`)}, srgbClr val="${THEME_FACTS[expected].background}" -> ${sample.includes(`srgbClr val="${THEME_FACTS[expected].background}"`)}`);
    }
  }
  for (const [label, ok] of checks) transcript(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 2);
}

main().catch((error) => {
  transcript(`HARNESS ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
