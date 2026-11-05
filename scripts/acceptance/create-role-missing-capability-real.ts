#!/usr/bin/env npx tsx
// N-ROLE-CREATE-UNKNOWN-TOOLS-FU2：glm-5.3 真跑 create-role「能力不在注册表」分支。
// 真实 create-role skill 提示词 + 真实 propose_role handler；注册表里没有订机票工具，
// 期望：编造名被 UNKNOWN_TOOLS 拒掉、或模型压根不编名，最终中文回复点名缺的能力，
// 落盘草稿的工具名全部真实；草稿写进临时数据目录。用法：source ~/.code-agent/.env 后
// npx tsx scripts/acceptance/create-role-missing-capability-real.ts
import process from 'node:process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const USER_REQUEST = '帮我建一个能订机票的专家';
const NUDGE = '就订机票这一件事，别的能力都不用加，按你的判断直接建吧。';
const MAX_ROUNDS = 6;
const MAX_TOKENS = 4096; // GLM coding 端点推理烧 max_tokens：给足，content 空时看 finish_reason
const CALL_TIMEOUT_MS = 120_000;

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string }

async function main(): Promise<void> {
  const apiKey = (process.env.ZHIPU_CODING_API_KEY ?? '').trim();
  if (apiKey === '') {
    console.log('SKIPPED: no key');
    console.log('reason: ZHIPU_CODING_API_KEY 未设置（set -a; source ~/.code-agent/.env; set +a 后重跑）');
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-role-missing-'));
  process.env.CODE_AGENT_DATA_DIR = dataDir; // 草稿/日志全进沙箱，避免写生产数据目录
  const [{ ZHIPU_CODING_TIER }, skillData, roleAuthoring, registryMod, knownMod, draftQueue] = await Promise.all([
    import('./_jev-real-sites-lib'),
    import('../../src/host/services/skills/builtinSkillsData'),
    import('../../src/host/tools/modules/roleAuthoring/proposeRole'),
    import('../../src/host/tools/protocolRegistry'),
    import('../../src/host/tools/knownToolNames'),
    import('../../src/host/services/roleAssets/roleDraftQueue'),
  ]);
  registryMod.getProtocolRegistry();
  const known = knownMod.getKnownToolNames();
  const skill = skillData.BUILTIN_SKILLS.find((s) => s.name === 'create-role');
  if (!skill) throw new Error('create-role skill not found in BUILTIN_SKILLS');
  const schema = roleAuthoring.proposeRoleModule.schema;
  const tools = [{
    type: 'function',
    function: { name: schema.name, description: schema.description, parameters: schema.inputSchema },
  }];
  console.log(`model=${ZHIPU_CODING_TIER.model} endpoint=${ZHIPU_CODING_TIER.baseUrl} dataDir=${dataDir}`);
  const messages: ChatMessage[] = [
    { role: 'system', content: skill.promptContent },
    { role: 'user', content: USER_REQUEST },
  ];
  let emittedFake = false;
  let sawUnknownTools = false;
  let drafted = false;
  let turnText = ''; // 同一 turn 里模型说给用户看的全部文本（含工具调用前后）
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const response = await fetch(`${ZHIPU_CODING_TIER.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ZHIPU_CODING_TIER.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: ToolCall[] }, finish_reason?: string }>;
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error(`no assistant message: ${JSON.stringify(payload)}`);
    const text = typeof message.content === 'string' ? message.content
      : message.content == null ? '' : JSON.stringify(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    console.log(`\n=== round ${round} finish_reason=${payload.choices?.[0]?.finish_reason} ===`);
    console.log(`assistant<<<\n${text}\n>>>`);
    console.log(`tool_calls=${JSON.stringify(toolCalls, null, 2)}`);
    turnText += `${text}\n`;
    if (toolCalls.length === 0) {
      if (drafted || round === MAX_ROUNDS) break;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: NUDGE });
      continue;
    }
    messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      if (call.function?.name !== schema.name) throw new Error(`unexpected tool: ${call.function?.name}`);
      const args = JSON.parse(call.function?.arguments ?? '{}') as { tools?: string[] };
      for (const name of args.tools ?? []) {
        if (!known.has(name)) { emittedFake = true; console.log(`FAKE_NAME_EMITTED=${name}`); }
      }
      const handler = await roleAuthoring.proposeRoleModule.createHandler();
      const result = await handler.execute(
        args as Record<string, unknown>,
        {
          sessionId: 'create-role-missing-capability-real',
          workingDir: dataDir,
          abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          logger: { info: () => {}, debug: () => {},
            warn: (m: string) => console.log(`[handler.warn] ${m}`),
            error: (m: string) => console.log(`[handler.error] ${m}`) },
          emit: (event: unknown) => console.log(`event=${JSON.stringify(event)}`),
        } as never,
        (async () => ({ allow: true })) as never,
      );
      const code = (result as { code?: string }).code;
      if (result.ok) drafted = true;
      if (!result.ok && code === 'UNKNOWN_TOOLS') sawUnknownTools = true;
      console.log(`tool_result(${call.id})<<<\n${JSON.stringify(result, null, 2)}\n>>>`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  const draftsDir = draftQueue.getRoleDraftsDir();
  const drafts = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir) : [];
  const invented: string[] = [];
  for (const id of drafts) {
    const metaPath = path.join(draftsDir, id, 'draft.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { roleId?: string; tools?: string[] };
    console.log(`draft ${id} roleId=${meta.roleId} tools=${JSON.stringify(meta.tools)}`);
    for (const name of meta.tools ?? []) if (!known.has(name)) invented.push(name);
  }
  const mentionsCapability = /(订机票|机票|航班|购票)/.test(turnText);
  const saysMissing = /(没有|暂无|暂不支持|暂未|无法|不能|不具备|不在)/.test(turnText);
  const pass = turnText.trim() !== '' && mentionsCapability && saysMissing
    && invented.length === 0 && (!emittedFake || sawUnknownTools);
  console.log(`SUMMARY: emittedFake=${emittedFake} sawUnknownTools=${sawUnknownTools} `
    + `drafts=${drafts.length} inventedInDrafts=${JSON.stringify(invented)} `
    + `finalMentionsCapability=${mentionsCapability} finalSaysMissing=${saysMissing}`);
  console.log(pass ? 'VERDICT: PASS' : 'VERDICT: FAIL');
  if (!pass) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
