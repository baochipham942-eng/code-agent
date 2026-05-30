// /errors — 最近出错的会话（admin 控制台 P2.2）
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';

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

type TrendSourceRow = {
  status: string | null;
  total_errors: number | null;
  uploaded_at: string;
};

type TrendPoint = {
  day: string;
  sessions: number;
  errorSessions: number;
  totalErrors: number;
  errorRate: number;
};

const TREND_DAYS = 14;

export default async function ErrorsPage() {
  const supabase = await createSupabaseServerClient();
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (TREND_DAYS - 1));

  const [{ data }, { data: trendRows }] = await Promise.all([
    supabase
      .from('telemetry_sessions')
      .select(
        'id, user_id, status, model_provider, model_name, total_errors, total_tokens, estimated_cost, uploaded_at',
      )
      .eq('status', 'error')
      .order('uploaded_at', { ascending: false })
      .limit(50)
      .returns<Row[]>(),
    supabase
      .from('telemetry_sessions')
      .select('status, total_errors, uploaded_at')
      .gte('uploaded_at', since.toISOString())
      .order('uploaded_at', { ascending: true })
      .limit(5000)
      .returns<TrendSourceRow[]>(),
  ]);
  const trend = buildTrend(trendRows ?? [], TREND_DAYS);
  const latest = trend[trend.length - 1];
  const totalTrendSessions = trend.reduce((sum, point) => sum + point.sessions, 0);
  const totalTrendErrorSessions = trend.reduce((sum, point) => sum + point.errorSessions, 0);
  const maxTrendErrors = Math.max(...trend.map((point) => point.totalErrors), 1);
  const trendErrorRate = totalTrendSessions > 0 ? totalTrendErrorSessions / totalTrendSessions : 0;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-6xl mx-auto">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">出错会话</h1>
        <p className="text-xs text-zinc-500 mt-1">最近 50 条 status=error 的会话，点 id 进根因页</p>
      </header>

      <section className="mb-8">
        <div className="grid grid-cols-4 gap-4 mb-4">
          <Stat label="14 天会话" value={totalTrendSessions.toLocaleString()} />
          <Stat label="错误会话" value={totalTrendErrorSessions.toLocaleString()} accent="red" />
          <Stat label="错误率" value={`${(trendErrorRate * 100).toFixed(1)}%`} />
          <Stat label="今日错误" value={(latest?.totalErrors ?? 0).toLocaleString()} accent="red" />
        </div>
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <div className="px-3 py-2 bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
            14 天错误趋势
          </div>
          <div className="p-3 space-y-2">
            {trend.map((point) => (
              <TrendBar key={point.day} point={point} maxErrors={maxTrendErrors} />
            ))}
          </div>
        </div>
      </section>

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
                    <Link
                      href={`/sessions/${encodeURIComponent(s.id)}`}
                      className="font-mono text-xs text-blue-400 hover:underline"
                    >
                      {s.id.length > 28 ? `${s.id.slice(0, 28)}…` : s.id}
                    </Link>
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

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
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

function TrendBar({ point, maxErrors }: { point: TrendPoint; maxErrors: number }) {
  const width = point.totalErrors > 0 ? Math.max(6, (point.totalErrors / maxErrors) * 100) : 0;
  return (
    <div className="grid grid-cols-[84px_1fr_150px] gap-3 items-center text-xs">
      <div className="font-mono text-zinc-500">{point.day.slice(5)}</div>
      <div className="h-7 rounded bg-zinc-900 overflow-hidden border border-zinc-800">
        <div
          className="h-full bg-red-500/60"
          style={{ width: `${width}%` }}
          aria-label={`${point.day} errors ${point.totalErrors}`}
        />
      </div>
      <div className="text-right text-zinc-400 tabular-nums">
        <span className={point.totalErrors > 0 ? 'text-red-300' : ''}>{point.totalErrors}</span>
        <span className="text-zinc-600"> errs · </span>
        <span>{(point.errorRate * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

function buildTrend(rows: TrendSourceRow[], days: number): TrendPoint[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const points = new Map<string, TrendPoint>();

  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - i);
    const day = toDayKey(date);
    points.set(day, {
      day,
      sessions: 0,
      errorSessions: 0,
      totalErrors: 0,
      errorRate: 0,
    });
  }

  for (const row of rows) {
    const day = toDayKey(new Date(row.uploaded_at));
    const point = points.get(day);
    if (!point) continue;
    point.sessions += 1;
    if (row.status === 'error') {
      point.errorSessions += 1;
      point.totalErrors += Math.max(Number(row.total_errors ?? 1), 1);
    }
  }

  return [...points.values()].map((point) => ({
    ...point,
    errorRate: point.sessions > 0 ? point.errorSessions / point.sessions : 0,
  }));
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
