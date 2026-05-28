// 按 sessionId 查根因 — 控制台第一刀的核心页面。
// 把"Q: 用户某个 session 效果不好/出错，我能不能查到根因?"包成 UI。
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Params = Promise<{ id: string }>;

type ModelCallSummary = {
  provider?: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  responseType?: string;
  error?: string;
  fallbackUsed?: { from?: string; to?: string; reason?: string };
};

type ToolCallSummary = {
  name?: string;
  success?: boolean;
  errorCategory?: string;
  durationMs?: number;
  error?: string;
};

type TurnPayload = {
  modelCalls?: ModelCallSummary[];
  toolCalls?: ToolCallSummary[];
};

export default async function SessionDetail({ params }: { params: Params }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const supabase = await createSupabaseServerClient();

  const { data: session } = await supabase
    .from('telemetry_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!session) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
        <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← 返回
        </a>
        <h1 className="text-xl font-semibold mt-4 mb-2">未找到会话</h1>
        <p className="text-zinc-400 text-sm">
          sessionId = <code className="text-zinc-300 font-mono">{id}</code> 不存在或还未上传。
        </p>
      </main>
    );
  }

  const { data: turns } = await supabase
    .from('telemetry_turns')
    .select('*')
    .eq('session_id', id)
    .order('turn_number', { ascending: true });

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8 max-w-5xl mx-auto">
      <a href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← 返回
      </a>

      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold font-mono break-all">{session.id}</h1>
        <div className="text-sm text-zinc-400 mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Pill status={session.status} />
          <span>
            {session.model_provider}/{session.model_name}
          </span>
          <span>{session.turn_count} turns</span>
          <span>{Number(session.total_tokens ?? 0).toLocaleString()} tokens</span>
          <span>${Number(session.estimated_cost ?? 0).toFixed(4)}</span>
          {session.total_errors > 0 ? (
            <span className="text-red-400">{session.total_errors} errors</span>
          ) : null}
        </div>
      </header>

      <section className="mb-8">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 mb-3">会话头</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <Row k="user_id" v={session.user_id} mono />
          <Row k="device_id" v={session.device_id ?? '—'} mono />
          <Row k="app_version" v={session.app_version ?? '—'} />
          <Row k="session_type" v={session.session_type ?? '—'} />
          <Row k="开始时间" v={session.start_time ? new Date(Number(session.start_time)).toLocaleString() : '—'} />
          <Row k="时长" v={session.duration_ms ? `${(Number(session.duration_ms) / 1000).toFixed(1)} s` : '—'} />
          <Row
            k="tokens"
            v={`${session.total_input_tokens ?? 0} in / ${session.total_output_tokens ?? 0} out`}
          />
          <Row
            k="工具调用"
            v={`${session.total_tool_calls ?? 0} 次（成功率 ${((Number(session.tool_success_rate ?? 0)) * 100).toFixed(1)}%）`}
          />
          <Row k="uploaded_at" v={new Date(session.uploaded_at).toLocaleString()} />
        </dl>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 mb-3">
          Turn 时间线（{turns?.length ?? 0}）
        </h2>
        {!turns || turns.length === 0 ? (
          <p className="text-zinc-500 text-sm">无 turn 记录。</p>
        ) : (
          <div className="space-y-3">
            {turns.map((t) => (
              <TurnCard key={t.id} turn={t} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-zinc-500">{k}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : ''}>{v}</dd>
    </>
  );
}

function Pill({ status }: { status?: string | null }) {
  const map: Record<string, string> = {
    error: 'bg-red-500/20 text-red-300',
    completed: 'bg-green-500/20 text-green-300',
    success: 'bg-green-500/20 text-green-300',
    failure: 'bg-red-500/20 text-red-300',
    partial: 'bg-amber-500/20 text-amber-300',
    recording: 'bg-blue-500/20 text-blue-300',
  };
  const color = (status && map[status]) || 'bg-zinc-700/60 text-zinc-300';
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{status ?? '—'}</span>;
}

function TurnCard({ turn }: { turn: Record<string, unknown> }) {
  const payload = (turn.payload ?? {}) as TurnPayload;
  const toolCalls = payload.toolCalls ?? [];
  const modelCalls = payload.modelCalls ?? [];
  const failedTools = toolCalls.filter((c) => c && c.success === false);
  const turnNumber = turn.turn_number as number | null;
  const turnType = turn.turn_type as string | null;
  const intent = turn.intent as string | null;
  const outcomeStatus = turn.outcome_status as string | null;
  const durationMs = turn.duration_ms as number | null;
  const errorCount = (turn.error_count as number | null) ?? 0;

  return (
    <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/30">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <span className="text-zinc-500 text-xs">
          #{turnNumber} · {turnType}
        </span>
        <span className="text-sm">{intent ?? '—'}</span>
        <Pill status={outcomeStatus ?? undefined} />
        {durationMs ? (
          <span className="text-zinc-500 text-xs">{(durationMs / 1000).toFixed(1)}s</span>
        ) : null}
        {errorCount > 0 ? (
          <span className="text-red-400 text-xs">{errorCount} errors</span>
        ) : null}
      </div>

      {modelCalls.length > 0 && (
        <div className="mb-2 text-xs text-zinc-500">
          <span className="uppercase tracking-wide mr-2">model</span>
          {modelCalls.map((m, i) => (
            <span key={i} className="mr-3 text-zinc-300">
              {m.provider}/{m.model} · {m.latencyMs}ms · {m.inputTokens}/{m.outputTokens}t
              {m.error ? <span className="text-red-400"> · {m.error}</span> : null}
            </span>
          ))}
        </div>
      )}

      {toolCalls.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {toolCalls.map((c, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={c.success ? 'text-green-400' : 'text-red-400'}>
                {c.success ? '✓' : '✗'}
              </span>
              <span className="font-mono text-xs">{c.name}</span>
              {c.errorCategory ? (
                <span className="text-red-400 text-xs">[{c.errorCategory}]</span>
              ) : null}
              <span className="text-zinc-500 text-xs ml-auto">{c.durationMs}ms</span>
              {c.error ? (
                <span className="basis-full pl-6 text-zinc-500 text-xs truncate">
                  {c.error}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-zinc-500 text-xs">无工具调用</p>
      )}

      {failedTools.length > 0 && (
        <p className="mt-3 text-xs text-red-400">
          ↑ 根因：{failedTools.length} 个工具失败
          （{failedTools.map((t) => t.errorCategory ?? t.name).filter(Boolean).join('，')}）
        </p>
      )}
    </div>
  );
}
