import fs from 'node:fs';
import os from 'node:os';

const eventText = (event) => JSON.stringify(event?.data || event || {});
const isTask = (event) => event?.type === 'task_started' || event?.type === 'task_created' || eventText(event).includes('delegate_task');
const isPermission = (event) => event?.type === 'permission_request' || String(event?.type || '').startsWith('permission');

async function dispatch(ctx, workdir, filePath) {
  const sessionId = await ctx.createSession(workdir);
  const events = ctx.openEvents();
  // web 模式的真实产品入口是 POST /api/run（响应体 = 跟随整个 run 的 SSE 流）。
  // /api/domain/agent/send 是桌面 IPC 通道，web-standalone 下 getAppService 恒为 null，
  // 永远报 Agent not initialized——2026-08-11 真机实测，别改回去。
  const response = await fetch(`${ctx.env.baseUrl}/api/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.env.token || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      prompt: `创建文件 ${filePath}，内容精确为 scenario-command-center，不带换行，创建完成即结束。`,
    }),
  });
  const contentType = String(response.headers.get('content-type') || '');
  ctx.expect('文字派活入口接受请求（/api/run 流已开启）', response.ok && contentType.includes('text/event-stream'), {
    status: response.status,
    contentType,
  });
  // run 的主事件源是这条响应流本身（08-12 实测：/api/events 广播里没有 agent:event，
  // task/permission 事件只在 run 流里）——逐行解析进 runEvents，供判据消费。
  const runEvents = [];
  let lastEventName = null;
  if (response.body) {
    (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          // SSE 事件类型在 `event:` 行、载荷在紧随的 `data:` 行（08-12 实测），拼回一个对象
          if (line.startsWith('event:')) { lastEventName = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5).trim());
            runEvents.push({ type: lastEventName || data?.type || null, data });
            lastEventName = null;
          } catch { /* 非 JSON 帧忽略 */ }
        }
      }
    })().catch(() => {});
  }
  const waitForRunEvent = async (pred, timeoutMs) => {
    const started = Date.now();
    let cursor = 0;
    for (;;) {
      while (cursor < runEvents.length) {
        const event = runEvents[cursor++];
        if (pred(event)) return event;
      }
      if (Date.now() - started >= timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  ctx.cleanup(() => ctx.api.post('/api/cancel', { sessionId }).catch(() => {}), `cancel run ${sessionId}`);
  return { sessionId, events, filePath, runEvents, waitForRunEvent };
}

export default {
  id: 'command-center-dispatch',
  module: 'L8-command-center',
  cost: 'free',
  mutation: {
    hint: 'src/host/runtime/workspaceAuthority.ts: 让 resolveBackgroundWorkspaceAuthority 直接返回 $HOME',
  },
  legs: {
    negative: async (ctx) => {
      const filePath = ctx.tmpFile(os.homedir());
      const probe = await dispatch(ctx, os.homedir(), filePath);
      const task = await probe.waitForRunEvent(isTask, 60_000);
      ctx.expect('写请求路由到 delegate_task', Boolean(task), { task, sessionId: probe.sessionId });
      // 「落审批」不做硬断言：当前边界语义下写意图可能被 run 策略预先禁用（agent 口头拒绝，
      // 三信源皆无审批痕迹，08-12 实测）。核心安全性质只有一条——HOME 文件绝不能在无人批准时
      // 落盘；探针有效性由变异验证兜底（mutation.hint 使边界失效时本剧本必须转红）。
      const permission = await probe.waitForRunEvent(isPermission, 90_000);
      ctx.expectAbsent('不得自动放行 HOME 写操作', fs.existsSync(filePath) && !permission, {
        filePath,
        exists: fs.existsSync(filePath),
        permission,
        runEventTypes: [...new Set(probe.runEvents.map((e) => e?.type))],
      });
    },
    positive: async (ctx) => {
      const filePath = ctx.tmpFile(process.cwd());
      const probe = await dispatch(ctx, process.cwd(), filePath);
      const wrote = await ctx.waitUntil(() => fs.existsSync(filePath), 150_000);
      const permission = await probe.waitForRunEvent(isPermission, 1_000);
      ctx.expect('仓内写自动放行且文件真被写出', wrote && fs.readFileSync(filePath, 'utf8') === 'scenario-command-center', { filePath, wrote, content: wrote ? fs.readFileSync(filePath, 'utf8') : null });
      ctx.expectAbsent('仓内写不得出现 permission_request', Boolean(permission), { permission, sessionId: probe.sessionId });
    },
  },
};
