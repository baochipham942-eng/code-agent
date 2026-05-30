// /feedback — 负反馈队列。管理员先看这里，再点 sessionId 进入根因页。
import { createSupabaseServerClient } from '@/lib/supabase/server';
import Link from 'next/link';

type FeedbackRow = {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  user_id: string | null;
  rating: number | null;
  comment: string | null;
  full_content: unknown;
  created_at: number | null;
  uploaded_at: string | null;
};

export default async function FeedbackPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('telemetry_feedback')
    .select('id, session_id, turn_id, user_id, rating, comment, full_content, created_at, uploaded_at')
    .eq('rating', -1)
    .order('uploaded_at', { ascending: false })
    .limit(100)
    .returns<FeedbackRow[]>();

  const feedback = data ?? [];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-6xl mx-auto">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回 dashboard
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">差评队列</h1>
        <p className="text-xs text-zinc-500 mt-1">
          最近 100 条负反馈，点 sessionId 进入 turn 时间线和工具根因。
        </p>
      </header>

      {feedback.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-normal">sessionId</th>
                <th className="text-left px-3 py-2 font-normal">turn</th>
                <th className="text-left px-3 py-2 font-normal">user</th>
                <th className="text-left px-3 py-2 font-normal">反馈内容</th>
                <th className="text-right px-3 py-2 font-normal">时间</th>
              </tr>
            </thead>
            <tbody>
              {feedback.map((item) => (
                <tr key={item.id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 align-top">
                    {item.session_id ? (
                      <Link
                        href={`/sessions/${encodeURIComponent(item.session_id)}`}
                        className="font-mono text-xs text-blue-400 hover:underline break-all"
                      >
                        {shortId(item.session_id)}
                      </Link>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-zinc-500 break-all">
                    {item.turn_id ? shortId(item.turn_id) : '—'}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-zinc-500">
                    {item.user_id ? `${item.user_id.slice(0, 8)}...` : '—'}
                  </td>
                  <td className="px-3 py-2 align-top max-w-xl">
                    {item.comment ? (
                      <p className="text-zinc-200 break-words">{item.comment}</p>
                    ) : null}
                    <p className="text-zinc-500 break-words">
                      {getFeedbackExcerpt(item.full_content) ?? '无全文片段'}
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top text-right text-zinc-400 text-xs">
                    {formatDate(item.uploaded_at ?? item.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-zinc-500 text-sm py-4">暂无负反馈。</p>
      )}
    </main>
  );
}

function shortId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 24)}...${value.slice(-4)}` : value;
}

function getFeedbackExcerpt(fullContent: unknown): string | null {
  if (!fullContent || typeof fullContent !== 'object') return null;
  const data = fullContent as Record<string, unknown>;
  const text =
    readString(data.assistantResponse) ??
    readString(data.completion) ??
    readString(data.output) ??
    readString(data.response);
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}
