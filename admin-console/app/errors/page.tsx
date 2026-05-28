// /errors — 最近出错的会话（admin 控制台 P2.2）
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Row = {
  id: string;
  user_id: string | null;
  status: string | null;
  model_provider: string | null;
  model_name: string | null;
  total_errors: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  uploaded_at: string;
};

export default async function ErrorsPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('telemetry_sessions')
    .select(
      'id, user_id, status, model_provider, model_name, total_errors, total_tokens, estimated_cost, uploaded_at',
    )
    .eq('status', 'error')
    .order('uploaded_at', { ascending: false })
    .limit(50)
    .returns<Row[]>();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </a>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">出错会话</h1>
        <p className="text-xs text-zinc-500 mt-1">最近 50 条 status=error 的会话,点 id 进根因页</p>
      </header>

      {data && data.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-normal">sessionId</th>
                <th className="text-left px-3 py-2 font-normal">user</th>
                <th className="text-left px-3 py-2 font-normal">模型</th>
                <th className="text-right px-3 py-2 font-normal">errors</th>
                <th className="text-right px-3 py-2 font-normal">tokens</th>
                <th className="text-right px-3 py-2 font-normal">$</th>
                <th className="text-right px-3 py-2 font-normal">时间</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-3 py-2">
                    <a
                      href={`/sessions/${encodeURIComponent(s.id)}`}
                      className="font-mono text-xs text-blue-400 hover:underline"
                    >
                      {s.id.length > 28 ? `${s.id.slice(0, 28)}…` : s.id}
                    </a>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                    {s.user_id ? `${s.user_id.slice(0, 8)}…` : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 text-xs">
                    {s.model_provider}/{s.model_name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-400">
                    {s.total_errors ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.total_tokens?.toLocaleString() ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.estimated_cost ? Number(s.estimated_cost).toFixed(4) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-400 text-xs">
                    {new Date(s.uploaded_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-zinc-500 text-sm py-4">无出错会话(好事)。</p>
      )}
    </main>
  );
}
