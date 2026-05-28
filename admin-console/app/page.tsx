// Fleet Observability 总览 + 按 sessionId 查根因入口。
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signOut } from '@/app/login/actions';

type SessionListRow = {
  id: string;
  user_id: string | null;
  status: string | null;
  model_provider: string | null;
  model_name: string | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  total_errors: number | null;
  uploaded_at: string;
};

export default async function Dashboard() {
  const supabase = await createSupabaseServerClient();

  const [{ count: totalSessions }, { count: errorSessions }, { data: recent }] = await Promise.all([
    supabase.from('telemetry_sessions').select('*', { count: 'exact', head: true }),
    supabase
      .from('telemetry_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'error'),
    supabase
      .from('telemetry_sessions')
      .select(
        'id, user_id, status, model_provider, model_name, total_tokens, estimated_cost, total_errors, uploaded_at',
      )
      .order('uploaded_at', { ascending: false })
      .limit(10)
      .returns<SessionListRow[]>(),
  ]);

  const errorRate =
    totalSessions && totalSessions > 0
      ? `${(((errorSessions ?? 0) / totalSessions) * 100).toFixed(1)}%`
      : '—';

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Fleet Observability</h1>
          <p className="text-xs text-zinc-500 mt-1">Agent Neo · 跨用户 trace 与崩溃</p>
        </div>
        <nav className="flex items-center gap-5 text-sm">
          <a href="/" className="text-zinc-100 hover:text-white">Dashboard</a>
          <a href="/users" className="text-zinc-400 hover:text-zinc-100">Users</a>
          <a href="/errors" className="text-zinc-400 hover:text-zinc-100">Errors</a>
          <form action={signOut}>
            <button className="text-zinc-500 hover:text-zinc-300">登出</button>
          </form>
        </nav>
      </header>

      <section className="grid grid-cols-3 gap-4 mb-8">
        <Stat label="会话总数" value={totalSessions ?? 0} />
        <Stat label="错误会话" value={errorSessions ?? 0} accent="red" />
        <Stat label="错误率" value={errorRate} />
      </section>

      <section className="mb-8">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 mb-3">按 sessionId 查根因</h2>
        <form action="/sessions/redirect" method="get" className="flex gap-2 max-w-2xl">
          <input
            name="id"
            required
            placeholder="贴一个 sessionId"
            className="flex-1 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none text-sm font-mono"
          />
          <button className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-sm font-medium">
            查
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 mb-3">最近 10 条会话</h2>
        {recent && recent.length > 0 ? (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 font-normal">id</th>
                  <th className="text-left px-3 py-2 font-normal">状态</th>
                  <th className="text-left px-3 py-2 font-normal">模型</th>
                  <th className="text-right px-3 py-2 font-normal">tokens</th>
                  <th className="text-right px-3 py-2 font-normal">$</th>
                  <th className="text-right px-3 py-2 font-normal">错误</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                    <td className="px-3 py-2">
                      <a
                        href={`/sessions/${encodeURIComponent(s.id)}`}
                        className="font-mono text-xs text-blue-400 hover:underline"
                      >
                        {s.id.length > 28 ? `${s.id.slice(0, 28)}…` : s.id}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <Pill status={s.status} />
                    </td>
                    <td className="px-3 py-2 text-zinc-400 text-xs">
                      {s.model_provider}/{s.model_name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.total_tokens?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.estimated_cost ? Number(s.estimated_cost).toFixed(4) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.total_errors ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-zinc-500 text-sm py-4">
            暂无数据 — 用户登录跑 session 后会自动上传出现在这里。
          </p>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'red';
}) {
  return (
    <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="text-xs text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent === 'red' ? 'text-red-400' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function Pill({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    error: 'bg-red-500/20 text-red-300',
    completed: 'bg-green-500/20 text-green-300',
    recording: 'bg-blue-500/20 text-blue-300',
  };
  const color = (status && map[status]) || 'bg-zinc-700/60 text-zinc-300';
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{status ?? '—'}</span>;
}
