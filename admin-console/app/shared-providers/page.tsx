// /shared-providers — 团队共享 provider（中转站）配置（混合方案的 DB 侧）
// 改模型白名单 / 开关 / 端点 / 授权门，零 Vercel 部署即生效。key 不在这里——表只存 api_key_env
// 变量名，真值在 Vercel env。需要先在 Vercel 配 CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB=1。
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { upsertSharedProvider, toggleSharedProvider, deleteSharedProvider } from './actions';

type Row = {
  id: string;
  display_name: string;
  base_url: string;
  protocol: string;
  billing_mode: string;
  models: Array<{ id: string; label?: string }>;
  required_capability: string | null;
  api_key_env: string;
  enabled: boolean;
  updated_at: string;
};

export default async function SharedProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('control_plane_shared_providers')
    .select('*')
    .order('updated_at', { ascending: false })
    .returns<Row[]>();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">← 返回 dashboard</Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">团队共享 Provider 配置</h1>
        <p className="text-xs text-zinc-500 mt-1">
          改模型白名单 / 开关 / 端点零 Vercel 部署即生效。key 不存这里——表只放 api_key_env 变量名，
          真值在 Vercel env。前提：Vercel 已配 <code className="text-zinc-400">CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB=1</code>
          + 对应 key 的 env 变量。授权给谁在 <Link href="/entitlements" className="text-emerald-400 hover:underline">授权页</Link>。
        </p>
      </header>

      {msg ? (
        <div className="mb-5 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{msg}</div>
      ) : null}

      <form action={upsertSharedProvider} className="mb-8 grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 p-4">
        <Field name="id" label="id（custom-xxx）" placeholder="custom-team-relay" required />
        <Field name="display_name" label="展示名" placeholder="团队共享" required />
        <Field name="base_url" label="中转站端点" placeholder="https://tokenflux.dev/v1" required />
        <Field name="api_key_env" label="key 所在的 Vercel env 变量名" placeholder="SHARED_RELAY_API_KEY" required />
        <Field name="required_capability" label="授权门 capability（空=所有登录用户）" placeholder="shared_relay" />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">协议</span>
            <select name="protocol" className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm">
              <option value="openai">openai</option>
              <option value="claude">claude</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">计费</span>
            <select name="billing_mode" className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm">
              <option value="unknown">unknown</option>
              <option value="payg">payg</option>
              <option value="plan">plan</option>
              <option value="free">free</option>
            </select>
          </label>
        </div>
        <label className="col-span-2 block">
          <span className="block text-xs text-zinc-500 mb-1">模型白名单（每行一个，"id" 或 "id | 展示名"）</span>
          <textarea name="models" rows={4} required placeholder={'gpt-5.5\ngpt-5.4-mini | GPT-5.4 mini'}
            className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono" />
        </label>
        <div className="col-span-2">
          <button type="submit" className="rounded-md bg-emerald-700 hover:bg-emerald-600 px-4 py-2 text-sm font-medium">
            保存 / 更新 provider
          </button>
        </div>
      </form>

      {data && data.length > 0 ? (
        <div className="space-y-3">
          {data.map((p) => (
            <div key={p.id} className="rounded-lg border border-zinc-800 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{p.display_name}</span>
                  <span className="ml-2 font-mono text-xs text-zinc-500">{p.id}</span>
                  {p.enabled
                    ? <span className="ml-3 text-xs text-emerald-400">● 启用</span>
                    : <span className="ml-3 text-xs text-zinc-600">○ 停用</span>}
                </div>
                <div className="flex items-center gap-2">
                  <form action={toggleSharedProvider}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="enabled" value={String(p.enabled)} />
                    <button className="rounded px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700">
                      {p.enabled ? '停用' : '启用'}
                    </button>
                  </form>
                  <form action={deleteSharedProvider}>
                    <input type="hidden" name="id" value={p.id} />
                    <button className="rounded px-2 py-1 text-xs bg-zinc-800 hover:bg-red-900/60 text-zinc-300">删除</button>
                  </form>
                </div>
              </div>
              <div className="mt-2 text-xs text-zinc-500 space-y-0.5">
                <div>端点：<span className="text-zinc-400">{p.base_url}</span> · 协议 {p.protocol} · 计费 {p.billing_mode}</div>
                <div>key env：<span className="text-zinc-400 font-mono">{p.api_key_env}</span> · 授权门：<span className="text-zinc-400">{p.required_capability || '（所有登录用户）'}</span></div>
                <div>模型：<span className="text-zinc-400 font-mono">{(p.models ?? []).map((m) => m.id).join(', ')}</span></div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-zinc-500 text-sm py-4">暂无共享 provider。用上面的表单加一个。</p>
      )}
    </main>
  );
}

function Field({ name, label, placeholder, required }: { name: string; label: string; placeholder?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-500 mb-1">{label}</span>
      <input
        name={name}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono outline-none focus:border-zinc-600"
      />
    </label>
  );
}
