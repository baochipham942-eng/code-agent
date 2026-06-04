// /entitlements — 团队共享 provider（中转站）授权管理
// 手动给某个用户开/关「走团队共享 key」。底层写 control_plane_entitlements 的 shared_relay capability，
// 控制面 cloud_config 网关据此按 subject 决定是否下发中转站 provider（含 key）。
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { grantSharedRelay, revokeSharedRelay } from './actions';

type Row = {
  user_id: string;
  status: string;
  plan: string;
  capabilities: string[];
  updated_at: string;
};

const SHARED_RELAY = 'shared_relay';

export default async function EntitlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('control_plane_entitlements')
    .select('user_id,status,plan,capabilities,updated_at')
    .order('updated_at', { ascending: false })
    .limit(200)
    .returns<Row[]>();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">团队共享 Key 授权</h1>
        <p className="text-xs text-zinc-500 mt-1">
          给用户开/关「走团队共享中转站 key」。授予后该用户下次启动 Neo 会自动拿到共享模型，零配置可用；
          撤销后下次拉取即自动消失。一键全员关：直接在中转站后台吊销/轮换那把 token。
        </p>
      </header>

      {msg ? (
        <div className="mb-5 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          {msg}
        </div>
      ) : null}

      {/* 授予表单 */}
      <form action={grantSharedRelay} className="mb-8 flex items-end gap-3">
        <label className="flex-1">
          <span className="block text-xs text-zinc-500 mb-1">用户 user_id（UUID，可从 Users 页复制）</span>
          <input
            name="user_id"
            required
            placeholder="00000000-0000-0000-0000-000000000000"
            className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono outline-none focus:border-zinc-600"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-emerald-700 hover:bg-emerald-600 px-4 py-2 text-sm font-medium"
        >
          授予共享 Key
        </button>
        <Link href="/users" className="text-xs text-zinc-500 hover:text-zinc-300 pb-2">
          查 user_id →
        </Link>
      </form>

      {data && data.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-normal">user_id</th>
                <th className="text-left px-3 py-2 font-normal">status</th>
                <th className="text-left px-3 py-2 font-normal">plan</th>
                <th className="text-center px-3 py-2 font-normal">共享 Key</th>
                <th className="text-right px-3 py-2 font-normal">更新</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => {
                const hasRelay = (u.capabilities ?? []).includes(SHARED_RELAY)
                  || (u.capabilities ?? []).includes('*');
                return (
                  <tr key={u.user_id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                    <td className="px-3 py-2 font-mono text-xs">
                      {u.user_id.slice(0, 8)}…{u.user_id.slice(-4)}
                    </td>
                    <td className="px-3 py-2 text-zinc-400">{u.status}</td>
                    <td className="px-3 py-2 text-zinc-400">{u.plan}</td>
                    <td className="px-3 py-2 text-center">
                      {hasRelay ? (
                        <span className="text-emerald-400">● 已开</span>
                      ) : (
                        <span className="text-zinc-600">○ 关</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-500 text-xs">
                      {new Date(u.updated_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={hasRelay ? revokeSharedRelay : grantSharedRelay}>
                        <input type="hidden" name="user_id" value={u.user_id} />
                        <button
                          type="submit"
                          className={`rounded px-2 py-1 text-xs ${
                            hasRelay
                              ? 'bg-zinc-800 hover:bg-red-900/60 text-zinc-300'
                              : 'bg-emerald-800 hover:bg-emerald-700 text-emerald-100'
                          }`}
                        >
                          {hasRelay ? '撤销' : '授予'}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-zinc-500 text-sm py-4">暂无 entitlement 记录。用上面的表单给第一个用户授予。</p>
      )}
    </main>
  );
}
