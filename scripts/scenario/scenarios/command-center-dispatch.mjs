import fs from 'node:fs';
import os from 'node:os';

const eventText = (event) => JSON.stringify(event?.data || event || {});
const isTask = (event) => event?.type === 'task_started' || event?.type === 'task_created' || eventText(event).includes('delegate_task');
const isPermission = (event) => event?.type === 'permission_request';

async function dispatch(ctx, workdir, filePath) {
  const sessionId = await ctx.createSession(workdir);
  const events = ctx.openEvents();
  const response = await ctx.api.post('/api/domain/agent/send', {
    sessionId,
    content: `创建文件 ${filePath}，内容精确为 scenario-command-center，不带换行，创建完成即结束。`,
  });
  ctx.expect('文字派活入口接受请求', response.status >= 200 && response.status < 300 && response.body?.success !== false, response);
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
