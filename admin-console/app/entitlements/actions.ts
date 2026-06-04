'use server';

// 团队共享 provider（中转站）授权管理 server actions。
// 写 control_plane_entitlements；admin RLS（is_code_agent_admin()）在 DB 层把关，
// 非管理员的 cookie 会话会被 RLS 拒绝，无需在此再判一次。

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const SHARED_RELAY_CAPABILITY = 'shared_relay';

type EntitlementRow = {
  user_id: string;
  status: string;
  plan: string;
  capabilities: string[];
};

async function loadEntitlement(userId: string): Promise<EntitlementRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('control_plane_entitlements')
    .select('user_id,status,plan,capabilities')
    .eq('user_id', userId)
    .maybeSingle<EntitlementRow>();
  return data ?? null;
}

function done(message: string): never {
  revalidatePath('/entitlements');
  redirect(`/entitlements?msg=${encodeURIComponent(message)}`);
}

/** 授予某用户「团队共享 provider」访问权（capabilities 并入 shared_relay，status 置 active）。 */
export async function grantSharedRelay(formData: FormData): Promise<void> {
  const userId = String(formData.get('user_id') ?? '').trim();
  if (!userId) done('缺少 user_id');

  const supabase = await createSupabaseServerClient();
  const existing = await loadEntitlement(userId);
  const capabilities = new Set(existing?.capabilities ?? []);
  capabilities.add(SHARED_RELAY_CAPABILITY);

  const { error } = await supabase
    .from('control_plane_entitlements')
    .upsert({
      user_id: userId,
      status: 'active',
      plan: existing?.plan && existing.plan !== 'free' ? existing.plan : 'team-relay',
      capabilities: Array.from(capabilities),
    }, { onConflict: 'user_id' });

  done(error ? `授予失败：${error.message}` : `已授予 ${userId.slice(0, 8)}…`);
}

/** 撤销某用户的「团队共享 provider」访问权（从 capabilities 移除 shared_relay）。 */
export async function revokeSharedRelay(formData: FormData): Promise<void> {
  const userId = String(formData.get('user_id') ?? '').trim();
  if (!userId) done('缺少 user_id');

  const supabase = await createSupabaseServerClient();
  const existing = await loadEntitlement(userId);
  if (!existing) done('该用户无 entitlement 记录');

  const capabilities = (existing!.capabilities ?? []).filter((c) => c !== SHARED_RELAY_CAPABILITY);
  const { error } = await supabase
    .from('control_plane_entitlements')
    .update({ capabilities })
    .eq('user_id', userId);

  done(error ? `撤销失败：${error.message}` : `已撤销 ${userId.slice(0, 8)}…`);
}
