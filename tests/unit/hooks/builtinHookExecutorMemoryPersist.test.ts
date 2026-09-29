import { describe, expect, it } from 'vitest';

import { BuiltinHookExecutor } from '../../../src/host/hooks/builtinHookExecutor';
import type { Message } from '../../../src/shared/contract';

// N-MEM-WRITECONF ④：session-end-memory-persist 的学习提取/持久化路径已整体删除
// （唯一调用链的 Memory 服务适配器恒返 null，路径不可达；且过滤行删除后残留的
// 持久化循环已无置信度门槛）。此测试钉住删除结果：若有人把该路径接回来——
// 无论适配器是否同时复活——这里必须变红。
describe('builtinHookExecutor: session-end-memory-persist 持久化路径已删除', () => {
  it('SessionEnd 钩子返回禁用 stub，不再提取/保存任何 learnings', async () => {
    const executor = new BuiltinHookExecutor();

    // 这组消息在旧提取器下至少产出 3 条 learnings：
    // 成功任务 0.8、偏好 0.7、重复工具序列 0.7 —— 后两条恰是旧 confidence > 0.7
    // 门槛会丢弃的低置信度成果，若无门槛的持久化循环复活，它们也会被全量落盘
    const toolSeq = (id: string, names: string[]) => ({
      id,
      role: 'assistant' as const,
      content: '',
      timestamp: 1,
      toolCalls: names.map((name, i) => ({ id: `${id}-t${i}`, name, arguments: {} })),
    });
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: '帮我重构这个模块并补齐单元测试，要求注释完整', timestamp: 1 },
      toolSeq('m2', ['read', 'edit']),
      { id: 'm3', role: 'user', content: '注释要保留，谢谢', timestamp: 2 },
      toolSeq('m4', ['read', 'edit']),
    ];

    const results = await executor.executeForEvent('SessionEnd', {
      sessionId: 'session-mem-persist-deleted',
      workingDirectory: '/tmp',
      messages,
    });

    const stub = results.find((r) => r.message?.includes('Memory persist hook disabled'));
    expect(stub, 'session-end-memory-persist 应返回禁用 stub，持久化路径不得复活').toBeDefined();

    // 旧存活路径的返回特征是 "Extracted and saved N learnings from this session"
    for (const r of results) {
      expect(r.message ?? '').not.toMatch(/[Ee]xtracted and saved \d+ learnings/);
    }
  });
});
