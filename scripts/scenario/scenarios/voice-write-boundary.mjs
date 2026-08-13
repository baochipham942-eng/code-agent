import fs from 'node:fs';
import os from 'node:os';

const eventText = (event) => JSON.stringify(event?.args || event?.data || event || {});
// SSE 帧是 {channel, args} 包裹层（08-13 真机实测）：任务启动的真实词汇是
// dag:event 的 task:status / agent:event 的 task_progress，不存在 task_started/task_created。
const isTask = (event) => {
  const type = event?.args?.type;
  return (event?.channel === 'dag:event' && type === 'task:status')
    || (event?.channel === 'agent:event' && type === 'task_progress');
};

async function voiceDispatch(ctx, workdir, filePath) {
  const sessionId = await ctx.createSession(workdir);
  const events = ctx.openEvents();
  const voice = await ctx.voice.connect(sessionId);
  await voice.waitLive(20_000);
  const injection = await voice.injectText(`帮我在后台起个任务：创建文件 ${filePath}，内容精确为 scenario-voice-boundary，不带换行，创建完成即结束。`);
  ctx.expect('语音文字注入成功', (injection.body?.data?.outcome || injection.body?.outcome) === 'injected', injection);
  return { sessionId, events, filePath, startedAt: Date.now() };
}

export default {
  id: 'voice-write-boundary',
  module: 'L7-voice',
  cost: 'paid',
  mutation: {
    hint: 'src/host/agent/orchestratorPermissions.ts: 把 needsParking 停车判定挪回 devModeAutoApprove 之后（复原 08-13 抓获的秒批洞）',
  },
  legs: {
    negative: async (ctx) => {
      const filePath = ctx.tmpFile(os.homedir());
      const probe = await voiceDispatch(ctx, os.homedir(), filePath);
      const task = await probe.events.waitFor(isTask, 60_000);
      ctx.expect('任务真的被创建', Boolean(task), { task, sessionId: probe.sessionId });
      // parkApproval 只写 pending_approvals + 桌面通知，不发 SSE permission_request
      // （08-13 真机实测），判据必须锚 DB 真实副作用而不是事件流。
      const parked = await ctx.waitUntil(() => {
        const rows = ctx.db.query(
          `SELECT id, status, payload_json FROM pending_approvals WHERE submitted_at >= ? ORDER BY submitted_at ASC`,
          [probe.startedAt],
        );
        return rows.find((row) => String(row.payload_json).includes(filePath)) || null;
      }, 120_000);
      ctx.expect('写请求停车挂起（pending_approvals 落行）', Boolean(parked), { parked, filePath, sessionId: probe.sessionId });
      // 秒批冒名的直接签名：时间窗内不允许出现该路径的 allow 决策
      const decisions = ctx.db.permissionDecisions({ since: probe.startedAt, until: Date.now() });
      const leakedAllow = decisions.rows.find((row) => String(row.summary).includes(filePath) && row.final_outcome === 'allow');
      ctx.expectAbsent('时间窗内无该路径的 allow 决策', Boolean(leakedAllow), { leakedAllow: leakedAllow || null, decisionCount: decisions.rows.length });
      ctx.expectAbsent('未批准即落盘', fs.existsSync(filePath), { filePath, exists: fs.existsSync(filePath), parkedId: parked?.id ?? null });
    },
    positive: async (ctx) => {
      const filePath = ctx.tmpFile(process.cwd());
      const probe = await voiceDispatch(ctx, process.cwd(), filePath);
      const wrote = await ctx.waitUntil(() => fs.existsSync(filePath), 150_000);
      ctx.expect('仓内写自动放行且文件真被写出', wrote && fs.readFileSync(filePath, 'utf8') === 'scenario-voice-boundary', { filePath, wrote, content: wrote ? fs.readFileSync(filePath, 'utf8') : null });
      const parkedRows = ctx.db.query(
        `SELECT id, payload_json FROM pending_approvals WHERE submitted_at >= ?`,
        [probe.startedAt],
      ).filter((row) => String(row.payload_json).includes(filePath));
      ctx.expectAbsent('仓内写未进停车队列', parkedRows.length > 0, { parkedRows, sessionId: probe.sessionId });
    },
  },
};
