// /users — per-user 用量与成本聚合（admin 控制台 P2.2）
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { fetchQualityRows, formatRate, formatRubricKey, overallPassRate, rollupByUser, type QualityBucket, type UserQuality } from '@/lib/postlaunch';

/**
 * 「上线后过率」那一列的回看窗口。
 *
 * 口径写清楚：视图的 day_start 是 `date_trunc('day', ...)`，走库时区（UTC），所以日桶是**自然日**；
 * 而 fetchQualityRows 的截止是 `now - N×24h` 的滚动值，落到 day_start 上稳定得到 N 个日桶，
 * 最新那个是当天的半桶。列头因此写「近 7 个自然日（UTC）」而不是「近 7 天」。
 */
const POST_LAUNCH_WINDOW_DAYS = 7;

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
  const [{ data }, quality] = await Promise.all([
    supabase
      .from('admin_per_user_telemetry')
      .select('*')
      .order('last_seen', { ascending: false })
      .limit(200)
      .returns<Row[]>(),
    fetchQualityRows(supabase, POST_LAUNCH_WINDOW_DAYS),
  ]);
  const qualityByUser = rollupByUser(quality.rows);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </Link>
      {quality.error ? (
        <p className="mt-4 px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-xs">
          上线后过率读取失败：{quality.error}。下面两列显示的「—」是没读到，不是没评过。
        </p>
      ) : quality.truncated ? (
        <p className="mt-4 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs">
          上线后过率的数据量超过单次读取上限，那一列只覆盖了窗口的一部分用户。
        </p>
      ) : null}
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
                <th className="text-right px-3 py-2 font-normal">
                  信号轮过率
                  <span className="block text-zinc-600 font-normal">近 {POST_LAUNCH_WINDOW_DAYS} 个自然日（UTC）</span>
                </th>
                <th className="text-right px-3 py-2 font-normal">
                  抽样轮过率
                  <span className="block text-zinc-600 font-normal">近 {POST_LAUNCH_WINDOW_DAYS} 个自然日（UTC）</span>
                </th>
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
                  <PostLaunchCells quality={qualityByUser.get(u.user_id)} />
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

/**
 * 该用户近 7 天的六维总过率，信号轮与抽样轮**两列分开**——信号轮是命中问题信号才评的，
 * 天然偏低，和抽样轮加在一起得到的数字什么都不代表（ADR-063 §4）。
 * 没评过是「—」，不是 0%。两列都取该用户最近那套 (judge, rubric) 口径。
 */
function PostLaunchCells({ quality }: { quality: UserQuality | undefined }) {
  if (!quality) {
    return (
      <>
        <td className="px-3 py-2 text-right text-zinc-600 text-xs">—</td>
        <td className="px-3 py-2 text-right text-zinc-600 text-xs">—</td>
      </>
    );
  }
  const rubric = formatRubricKey(quality.rubric);
  return (
    <>
      <ScopeCell bucket={quality.signal} rubric={rubric} />
      <ScopeCell bucket={quality.sample} rubric={rubric} />
    </>
  );
}

function ScopeCell({ bucket, rubric }: { bucket: QualityBucket | null; rubric: string }) {
  if (!bucket) return <td className="px-3 py-2 text-right text-zinc-600 text-xs">—</td>;
  const rate = overallPassRate(bucket);
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${rate !== null && rate < 0.8 ? 'text-red-400' : ''}`}
      title={`${bucket.turns} 轮进分母 · 口径 ${rubric}`}
    >
      {formatRate(rate)}
      <span className="text-zinc-600 text-xs"> / {bucket.turns} 轮</span>
    </td>
  );
}
