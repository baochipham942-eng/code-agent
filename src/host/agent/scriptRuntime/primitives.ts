// ============================================================================
// primitives —— 主线程侧 RPC dispatcher
//
// child process 里的 agent()/phase()/log()/tools.<name>() 是 RPC stub，把受控请求送到
// Host，由这里落地执行后回传。parallel()/pipeline() 不到 Host——它们在 child 侧用 Promise
// 组合多个 agent RPC（真正的并发排队发生在 Host ConcurrencyGate，child 只是发起 N 个调用）。
//
// 'tool'（PTC 通道）在这里只做**把关**，执行交给 ctx.executeTool——那是命令层注入的
// 既有工具管线入口。把关有三道，缺一不可：名单二次判定、无损 JSON 校验、失败带 toolName
// 回传（child 据此造 ToolCallError，脚本能 try/catch 继续跑）。
// ============================================================================

import { runAgentCall, type ScriptRunContext } from './agentBridge';
import { createHash } from 'node:crypto';
import type { AgentCallPayload, RpcRequest, RpcResponse, ToolCallPayload } from './types';
import { redactSecrets } from '../../security/secretRedaction';
import { assertNestedWorkflowMetadata } from './nestedGraphMetadata';

/**
 * 工具入参必须是**无损 JSON 对象**。
 *
 * child 用 v8.serialize 传值，能带过来 JSON 表达不了的东西：undefined 字段、BigInt、
 * NaN/Infinity、-0、Map/Set/Date、循环引用、稀疏数组的洞。下游工具管线按 JSON 处理，
 * 不在这里挡住就会变成「字段静默消失」或下游抛一个跟原因无关的错。
 * 逐调用拒绝而不是尽力而为——形态对齐 dsh Code Mode 的 dispatch bridge。
 */
function toLosslessJsonArgs(
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '工具入参必须是对象' };
  }
  const bad = findNonJsonValue(raw, new WeakSet(), 'args');
  if (bad) return { ok: false, error: `工具入参不是无损 JSON：${bad}` };
  return { ok: true, value: raw as Record<string, unknown> };
}

/** 返回第一处不可无损 JSON 化的路径描述；全部合规返回 null。 */
function findNonJsonValue(value: unknown, seen: WeakSet<object>, path: string): string | null {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return null;
  if (kind === 'number') {
    if (!Number.isFinite(value)) return `${path} 是 ${String(value)}`;
    // JSON.stringify(-0) === "0"，往返即丢符号。
    if (Object.is(value, -0)) return `${path} 是 -0`;
    return null;
  }
  if (kind !== 'object') return `${path} 是 ${kind}`;
  const obj = value as object;
  if (seen.has(obj)) return `${path} 是循环引用`;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      // 稀疏数组的洞在这里读成 undefined，会被下面的 kind 检查拒掉。
      const bad = findNonJsonValue(obj[i], seen, `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    return `${path} 是 ${obj.constructor?.name ?? '非普通'} 对象`;
  }
  for (const [key, child] of Object.entries(obj)) {
    const bad = findNonJsonValue(child, seen, `${path}.${key}`);
    if (bad) return bad;
  }
  return null;
}

/** 处理一条来自 child 的 RPC 请求，返回响应。永不抛出——错误打包进 RpcResponse.error。 */
export async function handleRpc(req: RpcRequest, ctx: ScriptRunContext): Promise<RpcResponse> {
  const metadata = req.metadata;
  try {
    if (metadata) assertNestedWorkflowMetadata(metadata);
    switch (req.kind) {
      case 'agent': {
        if (metadata) ctx.emitNestedGraph?.({ type: 'nested:node_started', metadata, timestamp: ctx.now() });
        const result = await runAgentCall(req.payload as AgentCallPayload, ctx);
        if (metadata) ctx.emitNestedGraph?.({
          type: 'nested:node_completed',
          metadata,
          timestamp: ctx.now(),
          resultRef: `journal-result:${createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 24)}`,
        });
        // 回传累计 spent，worker 侧 budget 镜像据此更新（脚本可 while(budget.remaining()>x) 收敛）。
        return { id: req.id, ok: true, result, spent: ctx.budget.spent() };
      }
      case 'tool': {
        const payload = req.payload as ToolCallPayload;
        const name = typeof payload?.name === 'string' ? payload.name : '';
        if (!name) return { id: req.id, ok: false, error: 'tool RPC 缺少工具名' };
        // child 是半信任方：它发来的工具名不作数，名单在 Host 侧再判一次。
        // 用 Set 精确判定而不是 includes 之外的宽匹配，且 Object.create(null) 语义的
        // 名字（__proto__ 之类）也只是普通字符串，进不了原型链。
        const allowed = new Set(ctx.visibleToolNames ?? []);
        if (!ctx.executeTool || !allowed.has(name)) {
          return {
            id: req.id,
            ok: false,
            toolName: name,
            error: `UNKNOWN_TOOL: ${name} 不在本次 run 开放的工具名单里`,
          };
        }
        const args = toLosslessJsonArgs(payload.args);
        if (!args.ok) return { id: req.id, ok: false, toolName: name, error: args.error };
        const outcome = await ctx.executeTool({ name, args: args.value, signal: ctx.signal });
        if (!outcome.ok) {
          return { id: req.id, ok: false, toolName: name, error: redactSecrets(outcome.error) };
        }
        return { id: req.id, ok: true, result: outcome.value };
      }
      case 'phase': {
        const { title } = req.payload as { title: string };
        ctx.emit({ runId: ctx.runId, type: 'run:phase', ts: ctx.now(), data: { title: redactSecrets(String(title)) } });
        return { id: req.id, ok: true, result: null };
      }
      case 'log': {
        const { message } = req.payload as { message: string };
        ctx.emit({ runId: ctx.runId, type: 'run:log', ts: ctx.now(), data: { message: redactSecrets(String(message)) } });
        return { id: req.id, ok: true, result: null };
      }
      default:
        return { id: req.id, ok: false, error: `unknown rpc kind: ${String((req as RpcRequest).kind)}` };
    }
  } catch (err) {
    if (metadata) ctx.emitNestedGraph?.({
      type: 'nested:node_failed',
      metadata,
      timestamp: ctx.now(),
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    });
    // 失败也回传当前 spent（agent 失败路径已记账）：否则 worker 侧 budget 镜像停在旧值，
    // 脚本 while(budget.remaining()>x) 会持续误判（Codex HIGH#2）。
    return {
      id: req.id,
      ok: false,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
      spent: ctx.budget.spent(),
    };
  }
}
