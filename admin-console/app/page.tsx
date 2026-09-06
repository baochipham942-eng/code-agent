// Fleet Observability 总览 + 按 sessionId 查根因入口。
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signOut } from '@/app/login/actions';
import Link from 'next/link';
import {
  DIMENSION_LABELS,
  POST_LAUNCH_DIMENSIONS,
  fetchQualityRows,
  formatRate,
  formatRubricKey,
  passRate,
  rollupByWeek,
  type QualityBucket,
} from '@/lib/postlaunch';

/** 首页「上线后质量」块的回看窗口。 */
const POST_LAUNCH_WINDOW_DAYS = 28;

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

  const [{ count: totalSessions }, { count: errorSessions }, { data: recent }, quality] = await Promise.all([
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
    fetchQualityRows(supabase, POST_LAUNCH_WINDOW_DAYS),
  ]);

  const qualityBuckets = rollupByWeek(quality.rows);

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
          <Link href="/" className="text-zinc-100 hover:text-white">Dashboard</Link>
          <Link href="/users" className="text-zinc-400 hover:text-zinc-100">Users</Link>
          <Link href="/entitlements" className="text-zinc-400 hover:text-zinc-100">授权</Link>
          <Link href="/shared-providers" className="text-zinc-400 hover:text-zinc-100">共享Provider</Link>
          <Link href="/errors" className="text-zinc-400 hover:text-zinc-100">Errors</Link>
          <Link href="/feedback" className="text-zinc-400 hover:text-zinc-100">Feedback</Link>
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

      <PostLaunchQuality buckets={qualityBuckets} truncated={quality.truncated} error={quality.error} />

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
                      <Link
                        href={`/sessions/${encodeURIComponent(s.id)}`}
                        className="font-mono text-xs text-blue-400 hover:underline"
                      >
                        {s.id.length > 28 ? `${s.id.slice(0, 28)}…` : s.id}
                      </Link>
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

function PostLaunchQuality({
  buckets,
  truncated,
  error,
}: {
  buckets: QualityBucket[];
  truncated: boolean;
  error: string | null;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500">上线后质量</h2>
        <span className="text-xs text-zinc-600">
          近 {POST_LAUNCH_WINDOW_DAYS / 7} 周 · 已剔除脚本与评测会话 · 信号轮与抽样轮分开看
        </span>
      </div>
      {truncated ? (
        <p className="mb-3 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs">
          数据量超过单次读取上限，下面只是这个窗口的一部分，不是全部。缩短窗口或按用户下钻再看。
        </p>
      ) : null}
      {error ? (
        // 读取失败绝不能显示成「暂无评分」——那会让人以为没人评过，还引导去开一个已经开着的开关。
        <p className="px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          读取失败：{error}
        </p>
      ) : buckets.length === 0 ? (
        <p className="text-zinc-500 text-sm py-4">
          暂无上线后评分 — 用户在「隐私防线 → 数据共享」里打开「上线后质量评分」并跑过一次评分后出现在这里。
        </p>
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-normal">周</th>
                <th className="text-left px-3 py-2 font-normal">版本</th>
                <th className="text-left px-3 py-2 font-normal">来源</th>
                <th className="text-right px-3 py-2 font-normal">轮</th>
                {POST_LAUNCH_DIMENSIONS.map((dimension) => (
                  <th key={dimension} className="text-right px-3 py-2 font-normal">
                    {DIMENSION_LABELS[dimension]}
                  </th>
                ))}
                <th className="text-right px-3 py-2 font-normal">$</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 text-zinc-400 text-xs whitespace-nowrap">
                    {bucket.weekStart.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 text-xs whitespace-nowrap">
                    {bucket.appVersion ?? '—'}
                    {bucket.promptVersion ? (
                      <span className="text-zinc-600"> · {bucket.promptVersion}</span>
                    ) : null}
                    <span className="block text-zinc-600">
                      {formatRubricKey({ judgeVersion: bucket.judgeVersion, rubricVersion: bucket.rubricVersion })}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        bucket.sampledBy === 'signal'
                          ? 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300'
                          : 'px-2 py-0.5 rounded bg-zinc-700/60 text-zinc-300'
                      }
                    >
                      {bucket.sampledBy === 'signal' ? '信号轮' : '抽样轮'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {bucket.turns}
                    {bucket.judgeUnavailableTurns > 0 ? (
                      <span className="text-amber-400 text-xs"> ·{bucket.judgeUnavailableTurns} 未判</span>
                    ) : null}
                  </td>
                  {POST_LAUNCH_DIMENSIONS.map((dimension) => {
                    const tally = bucket.dims[dimension];
                    const rate = passRate(tally);
                    return (
                      <td
                        key={dimension}
                        className={`px-3 py-2 text-right tabular-nums ${
                          rate !== null && rate < 0.8 ? 'text-red-400' : ''
                        }`}
                        title={`${tally.passed}/${tally.judged} 有判决的轮通过`}
                      >
                        {formatRate(rate)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400 text-xs">
                    {bucket.costUsd.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
