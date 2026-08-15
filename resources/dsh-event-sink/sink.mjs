/**
 * Neo 的 dsh 事件 sink —— 一个 Cordis 插件，订阅 dsh 的 session 事件、往 stdout
 * 逐行吐 NDJSON。
 *
 * 为什么需要它：`dsh --profile headless` 的 runner 只在最后 `io.stdout.write(最终答案)`，
 * 事件（工具调用、流式文本、session id）全部留在进程内 / 落盘私有格式里，Neo 拿不到。
 * dsh 把「一切皆插件」当设计意图，所以 Neo 不改 dsh 本体、也不去 tail 它未冻结的
 * `session.jsonl.zstd`，而是用 `--patch` 把这个插件挂进它的树（N-DSH1 分叉点探测的路线 C）。
 *
 * 版本风险全部关在这个文件里：dsh 是 0.1.0-rc，事件形状可能变；Neo 主干只多一个
 * `--patch` 参数，公共类型里不出现任何 dsh 的形状。
 *
 * 挂不上会怎样：dsh 的 `assertEntriesActivated` 会让整棵树 boot 失败、进程非零退出，
 * Neo 侧看到的是一次失败的 run —— 不是"事件流静默消失"。这是有意的 fail-loud。
 *
 * stdout 上会有两种行：本文件产的 NDJSON，以及 headless runner 最后那段纯文本答案。
 * 后者是重复内容（`final` 事件已经带了完整答案），Neo 侧按"非 JSON 行丢弃"处理。
 */

/** 插件名，dsh `--dump-config` 里能看到这一行挂在树上。 */
export const name = 'neo-event-sink';

/** 一行一个 JSON 对象；行内不允许出现裸换行，JSON.stringify 已经保证了。 */
function write(row) {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

/**
 * 把一条 dsh session 事件翻成 Neo 认的 NDJSON 行，翻不了就返回 null（丢弃）。
 * 只翻 Neo 真的会渲染的那几类，其余（request/header、todo/write、compaction/*…）
 * 一律不吐 —— 它们进 Neo 只会变成噪音。
 */
function toNeoRow(event) {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk;
      if (chunk.type === 'text-delta' && chunk.text) return { type: 'text', text: chunk.text };
      if (chunk.type === 'reasoning-delta' && chunk.text) return { type: 'reasoning', text: chunk.text };
      return null;
    }
    case 'assistant/message': {
      // 每个 step 都有一条；带文本的最后一条就是最终答案（headless runner 的 summarize
      // 也是这个口径）。只有工具调用、没有文本的中间步骤不产 final。
      const text = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return text ? { type: 'final', text } : null;
    }
    case 'tool/call':
      return { type: 'tool_call', name: event.data.name, callId: event.data.callId };
    case 'tool/result':
      return {
        type: 'tool_result',
        callId: event.data.message.source?.callId,
        ...(event.data.error ? { error: `${event.data.error.code}: ${event.data.error.name}` } : {}),
      };
    case 'turn/end': {
      const reason = event.data.reason;
      if (reason?.kind === 'error') {
        return { type: 'error', message: `${reason.error.code}: ${reason.error.message}` };
      }
      return { type: 'turn_end', reason: reason?.kind ?? 'unknown' };
    }
    default:
      return null;
  }
}

/**
 * 挂载：不 inject 任何服务，好让插件在 agent 建会话之前就把监听装上
 * （inject 的行会等服务就绪，可能晚于 runner 建会话，那样开头的事件就丢了）。
 */
export function apply(ctx) {
  // headless 一次只跑一个会话。第一个宣告出来的就是它；之后万一有别的（子 agent），
  // 事件不属于同一个会话就不吐 —— 宁可少吐，也不把两条流搅在一起。
  let ownSession;

  ctx.on('session/created', (session) => {
    if (ownSession !== undefined) return;
    ownSession = session;
    // durable 恢复的锚点：runner 进程内 randomUUID 生成、从不打印，这里是它唯一的出口。
    write({ type: 'session', sessionId: String(session.id) });
  });

  ctx.on('session/event', (session, event) => {
    if (session !== ownSession) return;
    const row = toNeoRow(event);
    if (row !== null) write(row);
  });
}
