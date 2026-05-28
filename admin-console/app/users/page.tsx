// /users — per-user 用量与成本聚合（admin 控制台 P2.2）
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Row = {
  user_id: string;
  sessions: number;
  errors: number;
  total_tokens: number;
  total_cost: number;
  total_tool_calls: number;
  last_seen: string;
  first_seen: string;
};

export default async function UsersPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('admin_per_user_telemetry')
    .select('*')
    .order('last_seen', { ascending: false })
    .limit(200)
    .returns<Row[]>();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </a>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-xs text-zinc-500 mt-1">
          per-user 聚合（来自 admin_per_user_telemetry view,admin-only RLS）
        </p>
      </header>

      {data && data.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-normal">user_id</th>
                <th className="text-right px-3 py-2 font-normal">会话</th>
                <th className="text-right px-3 py-2 font-normal">错误</th>
                <th className="text-right px-3 py-2 font-normal">tokens</th>
                <th className="text-right px-3 py-2 font-normal">$</th>
                <th className="text-right px-3 py-2 font-normal">工具</th>
                <th className="text-right px-3 py-2 font-normal">最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.user_id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 font-mono text-xs">
                    {u.user_id.slice(0, 8)}…{u.user_id.slice(-4)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.sessions}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${u.errors > 0 ? 'text-red-400' : ''}`}
                  >
                    {u.errors}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number(u.total_tokens).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {Number(u.total_cost).toFixed(4)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.total_tool_calls}</td>
                  <td className="px-3 py-2 text-right text-zinc-400 text-xs">
                    {new Date(u.last_seen).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-zinc-500 text-sm py-4">暂无用户聚合数据。</p>
      )}
    </main>
  );
}
