'use server';

// 团队共享 provider（中转站）配置管理 server actions。
// 写 control_plane_shared_providers（admin RLS 把关）。key 不在这里——表只存 api_key_env 变量名，
// 真值由控制面从 Vercel env 取。改模型白名单/开关/端点全程零 Vercel 部署。

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function done(message: string): never {
  revalidatePath('/shared-providers');
  redirect(`/shared-providers?msg=${encodeURIComponent(message)}`);
}

/** textarea 解析：每行 "id" 或 "id | 展示名" → [{id,label?}]。 */
function parseModels(raw: string): Array<{ id: string; label?: string }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, label] = line.split('|').map((s) => s.trim());
      return label ? { id, label } : { id };
    })
    .filter((m) => m.id.length > 0);
}

export async function upsertSharedProvider(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const displayName = String(formData.get('display_name') ?? '').trim();
  const baseUrl = String(formData.get('base_url') ?? '').trim();
  const apiKeyEnv = String(formData.get('api_key_env') ?? '').trim();
  const protocol = String(formData.get('protocol') ?? 'openai').trim();
  const billingMode = String(formData.get('billing_mode') ?? 'unknown').trim();
  const requiredCapability = String(formData.get('required_capability') ?? '').trim();
  const models = parseModels(String(formData.get('models') ?? ''));

  if (!/^custom-[a-z0-9][a-z0-9-]*$/i.test(id)) {
    done('id 必须是 custom-xxx 形态');
  }
  if (!displayName || !baseUrl || !apiKeyEnv || models.length === 0) {
    done('display_name / base_url / api_key_env / 至少一个模型 必填');
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('control_plane_shared_providers')
    .upsert({
      id,
      display_name: displayName,
      base_url: baseUrl,
      protocol: protocol === 'claude' ? 'claude' : 'openai',
      billing_mode: ['free', 'plan', 'payg', 'unknown'].includes(billingMode) ? billingMode : 'unknown',
      models,
      required_capability: requiredCapability || null,
      api_key_env: apiKeyEnv,
      enabled: true,
    }, { onConflict: 'id' });

  done(error ? `保存失败：${error.message}` : `已保存 ${id}`);
}

export async function toggleSharedProvider(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) done('缺少 id');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('control_plane_shared_providers')
    .update({ enabled: !enabled })
    .eq('id', id);

  done(error ? `操作失败：${error.message}` : `${id} 已${!enabled ? '启用' : '停用'}`);
}

export async function deleteSharedProvider(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) done('缺少 id');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('control_plane_shared_providers')
    .delete()
    .eq('id', id);

  done(error ? `删除失败：${error.message}` : `已删除 ${id}`);
}
