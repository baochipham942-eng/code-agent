/**
 * Ink chat 薄入口（沿用 spike 模式）：cjs bundle 不支持 top-level await，
 * ink 模块顶层同步读取 Yoga 枚举，所以先 await yogaReady 再动态 import 主体。
 * chat.ts 只在 TTY 判定通过后动态 import 本模块，非 TTY/管道场景零 Ink 开销。
 */
import { yogaReady } from './yogaCjsShim';
import type { CLIAgent } from '../adapter';
import type { InkChatOptions } from './App';

export async function runInkChat(agent: CLIAgent, options: InkChatOptions): Promise<void> {
  await yogaReady;
  const { startInkChat } = await import('./main');
  await startInkChat(agent, options);
}
