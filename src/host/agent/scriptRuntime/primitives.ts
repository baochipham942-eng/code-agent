// ============================================================================
// primitives —— 主线程侧 RPC dispatcher
//
// child process 里的 agent()/phase()/log() 是 RPC stub，把受控请求送到 Host，由这里
// 落地执行后回传。parallel()/pipeline() 不到 Host——它们在 child 侧用 Promise 组合多个
// agent RPC（真正的并发排队发生在 Host ConcurrencyGate，child 只是发起 N 个 agent 调用）。
// ============================================================================

import { runAgentCall, type ScriptRunContext } from './agentBridge';
import type { AgentCallPayload, RpcRequest, RpcResponse } from './types';
import { redactSecrets } from '../../security/secretRedaction';

/** 处理一条来自 child 的 RPC 请求，返回响应。永不抛出——错误打包进 RpcResponse.error。 */
export async function handleRpc(req: RpcRequest, ctx: ScriptRunContext): Promise<RpcResponse> {
  try {
    switch (req.kind) {
      case 'agent': {
        const result = await runAgentCall(req.payload as AgentCallPayload, ctx);
        // 回传累计 spent，worker 侧 budget 镜像据此更新（脚本可 while(budget.remaining()>x) 收敛）。
        return { id: req.id, ok: true, result, spent: ctx.budget.spent() };
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
