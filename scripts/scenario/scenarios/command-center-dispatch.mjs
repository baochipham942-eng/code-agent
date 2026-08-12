import fs from 'node:fs';
import os from 'node:os';

const eventText = (event) => JSON.stringify(event?.data || event || {});
const isTask = (event) => event?.type === 'task_started' || event?.type === 'task_created' || eventText(event).includes('delegate_task');
const isPermission = (event) => event?.type === 'permission_request';

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
  // 后台排空响应流防背压；判据一律走 /api/events 采集与真实副作用，不依赖这条流的内容
  if (response.body) {
    (async () => {
      const reader = response.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })().catch(() => {});
  }
  ctx.cleanup(() => ctx.api.post('/api/cancel', { sessionId }).catch(() => {}), `cancel run ${sessionId}`);
  return { sessionId, events, filePath };
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
      const task = await probe.events.waitFor(isTask, 60_000);
      ctx.expect('写请求路由到 delegate_task', Boolean(task), { task, sessionId: probe.sessionId });
      const permission = await probe.events.waitFor(isPermission, 120_000);
      ctx.expect('HOME 写操作落审批', Boolean(permission), { permission, sessionId: probe.sessionId });
      ctx.expectAbsent('不得自动放行 HOME 写操作', fs.existsSync(filePath) && !permission, { filePath, exists: fs.existsSync(filePath), permission });
    },
    positive: async (ctx) => {
      const filePath = ctx.tmpFile(process.cwd());
      const probe = await dispatch(ctx, process.cwd(), filePath);
      const wrote = await ctx.waitUntil(() => fs.existsSync(filePath), 150_000);
      const permission = await probe.events.waitFor(isPermission, 1_000);
      ctx.expect('仓内写自动放行且文件真被写出', wrote && fs.readFileSync(filePath, 'utf8') === 'scenario-command-center', { filePath, wrote, content: wrote ? fs.readFileSync(filePath, 'utf8') : null });
      ctx.expectAbsent('仓内写不得出现 permission_request', Boolean(permission), { permission, sessionId: probe.sessionId });
    },
  },
};
