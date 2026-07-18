import type { ConversationRuntime } from '../../agent/runtime/conversationRuntime';
import { createLogger } from '../../services/infra/logger';
import type { GraphExecutorContext, GraphExecutorPort } from '../graphExecutorPort';
import type { GraphJsonValue, GraphNode, GraphNodeResult } from '../graphTypes';

const logger = createLogger('NativeConversationExecutor');

export interface NativeConversationGraphInput { message: string }
type NativeRuntime = Pick<ConversationRuntime, 'run' | 'cancel' | 'pause' | 'resume' | 'steer'>;

export interface NativeConversationExecutorOptions {
  id?: string;
  runtimeFactory(node: GraphNode, context: GraphExecutorContext): NativeRuntime;
}

/** Lifecycle-only adapter. ConversationRuntime remains the only model/tool loop. */
export class NativeConversationExecutor implements GraphExecutorPort {
  readonly id: string;
  private readonly active = new Map<string, NativeRuntime>();

  constructor(private readonly options: NativeConversationExecutorOptions) {
    this.id = options.id ?? 'native_conversation';
  }

  canExecute(node: GraphNode): boolean {
    return node.executorRef === this.id || node.kind === 'native_conversation';
  }

  async execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult> {
    const input = parseNativeConversationInput(node.input);
    const runtime = this.options.runtimeFactory(node, context);
    const key = this.key(context, node);
    this.active.set(key, runtime);
    try {
      await context.progress({ lifecycle: 'conversation_started' });
      await runtime.run(input.message);
      return { status: 'completed', output: { completed: true }, sideEffectState: 'confirmed' };
    } catch (error) {
      if (context.signal.aborted) return { status: 'cancelled', error: String(context.signal.reason ?? 'cancelled') };
      return { status: 'failed', error: error instanceof Error ? error.message : String(error), retryable: false, sideEffectState: 'confirmed' };
    } finally {
      this.active.delete(key);
    }
  }

  async cancel(node: GraphNode, context: GraphExecutorContext): Promise<void> {
    await this.active.get(this.key(context, node))?.cancel('user');
  }

  pause(runId: string, nodeId: string): void { this.active.get(`${runId}:${nodeId}`)?.pause(); }
  resume(runId: string, nodeId: string): void { this.active.get(`${runId}:${nodeId}`)?.resume(); }
  steer(runId: string, nodeId: string, message: string): void {
    void Promise.resolve(this.active.get(`${runId}:${nodeId}`)?.steer(message)).catch((err) => {
      logger.error('[NativeConversationExecutor] steer persist failed', err);
    });
  }

  private key(context: GraphExecutorContext, node: GraphNode): string { return `${context.runId}:${node.nodeId}`; }
}

function parseNativeConversationInput(value: GraphJsonValue): NativeConversationGraphInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { message?: unknown }).message !== 'string') {
    throw new Error('native conversation graph input requires message');
  }
  return structuredClone(value) as unknown as NativeConversationGraphInput;
}
