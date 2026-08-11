import fs from 'node:fs';
import os from 'node:os';

const eventText = (event) => JSON.stringify(event?.data || event || {});
const isTask = (event) => event?.type === 'task_started' || event?.type === 'task_created' || eventText(event).includes('delegate_task');
const isPermission = (event) => event?.type === 'permission_request';

async function voiceDispatch(ctx, workdir, filePath) {
  const sessionId = await ctx.createSession(workdir);
  const events = ctx.openEvents();
  const voice = await ctx.voice.connect(sessionId);
  await voice.waitLive(20_000);
  const injection = await voice.injectText(`帮我在后台起个任务：创建文件 ${filePath}，内容精确为 scenario-voice-boundary，不带换行，创建完成即结束。`);
  ctx.expect('语音文字注入成功', (injection.body?.data?.outcome || injection.body?.outcome) === 'injected', injection);
  return { sessionId, events, filePath };
}

export default {
  id: 'voice-write-boundary',
  module: 'L7-voice',
  cost: 'paid',
  mutation: {
    hint: 'src/host/runtime/workspaceAuthority.ts: 让 resolveBackgroundWorkspaceAuthority 直接返回 $HOME',
  },
  legs: {
    negative: async (ctx) => {
      const filePath = ctx.tmpFile(os.homedir());
      const probe = await voiceDispatch(ctx, os.homedir(), filePath);
      const task = await probe.events.waitFor(isTask, 60_000);
      ctx.expect('任务真的被创建', Boolean(task), { task, sessionId: probe.sessionId });
      const permission = await probe.events.waitFor(isPermission, 120_000);
      ctx.expect('写操作落审批 rule=W3: outside_project', Boolean(permission) && eventText(permission).includes('W3: outside_project'), { permission, sessionId: probe.sessionId });
      ctx.expectAbsent('未批准即落盘', fs.existsSync(filePath) && !permission, { filePath, exists: fs.existsSync(filePath), permission });
    },
    positive: async (ctx) => {
      const filePath = ctx.tmpFile(process.cwd());
      const probe = await voiceDispatch(ctx, process.cwd(), filePath);
      const wrote = await ctx.waitUntil(() => fs.existsSync(filePath), 150_000);
      const permission = await probe.events.waitFor(isPermission, 1_000);
      ctx.expect('仓内写自动放行且文件真被写出', wrote && fs.readFileSync(filePath, 'utf8') === 'scenario-voice-boundary', { filePath, wrote, content: wrote ? fs.readFileSync(filePath, 'utf8') : null });
      ctx.expectAbsent('未出现 permission_request', Boolean(permission), { permission, sessionId: probe.sessionId });
    },
  },
};
