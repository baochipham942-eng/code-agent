// ============================================================================
// Supabase 会话行同步（QA 2026-07-28 A5）
// 新会话才写标题（upsert 首条消息生成的标题）；后续轮只更新模型/时间戳，
// 不用当前 prompt 覆盖已有标题——否则侧栏标题会跟随最后一条消息漂移。
// 从 routes/agent.ts 拆出（两处完全相同的调用块），同时控制单文件行数。
// ============================================================================

import type { SupabaseAgentBinding } from '../routes/agentRouteTypes';

export async function syncSupabaseSessionRow(
  sb: SupabaseAgentBinding,
  args: {
    sessionId: string;
    isNewSession: boolean;
    title: string;
    provider: string;
    model: string;
  },
): Promise<void> {
  const sessionsTable = sb.supabase.from('sessions');
  if (args.isNewSession) {
    await sessionsTable.upsert({
      id: args.sessionId,
      user_id: sb.userId,
      title: args.title,
      model_provider: args.provider,
      model_name: args.model,
      created_at: Date.now(),
      updated_at: Date.now(),
      source_device_id: 'web',
    }, { onConflict: 'id' });
    return;
  }
  await sessionsTable.update({
    model_provider: args.provider,
    model_name: args.model,
    updated_at: Date.now(),
    source_device_id: 'web',
  }).eq('id', args.sessionId);
}
