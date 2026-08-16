/**
 * Neo 的 dsh resume runner —— 一个 Cordis 插件，顶掉 shipped 的 `headless-runner`
 * （patch 里对它 `disabled: true`），把 `agents.create(新 randomUUID)` 换成
 * `agents.resume(已落库的 session id)`，其余照抄原 runner 的收尾顺序：
 * whenIdle → followup → whenIdle → sessions.flush → 打印 → io.exit。
 *
 * 为什么零 import（和 sink.mjs 同一条命）：dsh loader 对裸包名的解析基准是插件文件
 * 自己的位置（Neo 的 resources/ 目录，那里没有 dsh 的 node_modules），import 任何
 * `@deepseek-ai/*` 都会在 mount 时炸。原 runner 用到的三个跨包符号都能不 import：
 * - `SessionId()` 是纯编译期 cast（dsh-session/lib/types/types.js 就一句 return id），
 *   运行时传裸字符串即可；
 * - `createUserMessage` 只做「补 id + 冻结」，而 Session 落账时 `assertMessageEventShape`
 *   校验的只有 {id 非空串, role:'user', source.kind 非空串, content 数组} 四项，
 *   这里手搓同形状对象（`crypto.randomUUID` 是 Node 全局）；
 * - `installModelSelection` 只是把动态换模型的选择覆写进请求，headless 一次一跑
 *   用不上——agent loop 缺 provider/model 时直接读 `agentOptions`（都没有会 fail-loud 抛错），
 *   所以把 `agentDefaultModel.currentSelection()` 塞进 `agentOptions` 就够了。
 *
 * 版本风险与 sink 同规矩：全关在这个文件里，dsh 是 0.1.0-rc，形状变了改这里，
 * Neo 的公共类型不出现任何 dsh 的形状。挂不上同样 fail-loud：`assertEntriesActivated`
 * 让整棵树 boot 失败、进程非零退出。
 */

/** 插件名，dsh `--dump-config` 里能看到这一行挂在树上。 */
export const name = 'neo-resume-runner';

/** 与原 runner 相同的三个核心服务；headlessStartup 由 patch 行的 inject 补上。 */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];

/** 照抄原 runner 的 summarize：取本轮 turn/start 之后的最后一段 assistant 文本与收尾原因。 */
function summarize(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/** 手搓一条 user message：形状即 createUserMessage 的产物，Session 落账时会深冻结。 */
function userMessage(task) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: task }],
  };
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;
  const resumeSessionId = typeof config?.resumeSessionId === 'string' ? config.resumeSessionId.trim() : '';
  if (resumeSessionId === '') throw new Error('neo-resume-runner: config.resumeSessionId is required');
  const task = typeof config?.task === 'string' ? config.task.trim() : '';
  if (task === '') throw new Error('neo-resume-runner: a non-empty task is required');
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.resume({
    resumeSessionId,
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(userMessage(task));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(outcome.text + '\n');
  if (outcome.reason?.kind === 'error') io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1);
}

/** 挂载：拿不到 appExit 就抛（原 runner 同款，别静默）。 */
export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('neo-resume-runner: the launcher must provide ctx.appExit before the tree mounts');
  const io = { stdout: process.stdout, stderr: process.stderr, exit };
  run(ctx, config, io).catch((error) => {
    fail(io, error);
  });
}
