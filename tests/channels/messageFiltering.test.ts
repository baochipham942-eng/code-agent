// ============================================================================
// 消息过滤与渲染逻辑测试
// 测试 ChatView.tsx 的 filteredMessages 和 MessageBubble 路由逻辑
//
// Testing Principles:
//   EP: 消息角色 (user/assistant/tool/system)、内容状态、属性组合
//   BVA: 0/1/many 消息、空数组
//   Decision Table: 角色×内容×toolCalls×isMeta×compaction 组合
//   Bug Pattern: 空 assistant 显示、tool 消息泄露、isMeta 可见
// ============================================================================

import { describe, it, expect } from 'vitest';

// ============================================================================
// 从 ChatView.tsx:105-128 提取的消息过滤逻辑（纯函数化）
// ============================================================================

interface TestMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: Array<{ id: string; name: string; result?: string }>;
  isMeta?: boolean;
  compaction?: { compactedMessageCount: number; compactedTokenCount: number; content: string };
  source?: string;
}

/**
 * 消息过滤逻辑 — 精确复现 ChatView.tsx filteredMessages useMemo
 */
function filterMessages(messages: TestMessage[]): TestMessage[] {
  return messages.filter((message) => {
    // Compaction 消息始终显示
    if (message.compaction) {
      return true;
    }

    // Skill 系统：isMeta 消息不渲染到 UI
    if (message.isMeta) {
      return false;
    }

    // 过滤 tool 消息
    if (message.role === 'tool') {
      return false;
    }

    if (message.role === 'assistant') {
      const hasContent = message.content && message.content.trim().length > 0;
      const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
      return hasContent || hasToolCalls;
    }
    return true;
  });
}

/**
 * MessageBubble 路由逻辑 — 复现 MessageBubble/index.tsx
 */
function routeMessageBubble(message: TestMessage): 'compaction' | 'skill' | 'hidden' | 'user' | 'assistant' {
  if (message.compaction) return 'compaction';
  if (message.source === 'skill') return 'skill';
  if (message.role === 'system') return 'hidden';
  if (message.role === 'user') return 'user';
  return 'assistant';
}

// ============================================================================
// 测试套件
// ============================================================================

describe('消息过滤逻辑 (ChatView filteredMessages)', () => {

  // ---- EP: 按消息角色分区 ----

  describe('EP: 消息角色过滤', () => {
    it('user 消息 → 始终显示', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '你好' },
        { role: 'user', content: '' },  // 即使空内容也显示
      ];
      expect(filterMessages(messages)).toHaveLength(2);
    });

    it('assistant 有内容 → 显示', () => {
      const result = filterMessages([
        { role: 'assistant', content: '回复内容' },
      ]);
      expect(result).toHaveLength(1);
    });

    it('assistant 空内容无 toolCalls → 隐藏', () => {
      const result = filterMessages([
        { role: 'assistant', content: '' },
      ]);
      expect(result).toHaveLength(0);
    });

    it('assistant 纯空白内容无 toolCalls → 隐藏', () => {
      const result = filterMessages([
        { role: 'assistant', content: '   \n\t  ' },
      ]);
      expect(result).toHaveLength(0);
    });

    it('assistant 空内容有 toolCalls → 显示（工具调用消息）', () => {
      const result = filterMessages([
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file' }] },
      ]);
      expect(result).toHaveLength(1);
    });

    it('tool 消息 → 始终隐藏', () => {
      const result = filterMessages([
        { role: 'tool', content: '{"result": "ok"}' },
        { role: 'tool', content: '大量文件内容...' },
      ]);
      expect(result).toHaveLength(0);
    });

    it('system 消息 → 通过过滤器（由 MessageBubble 渲染 null）', () => {
      // ChatView 的 filter 不过滤 system，但 MessageBubble 渲染时返回 null
      const result = filterMessages([
        { role: 'system' as 'system', content: 'nudge hint' },
      ]);
      expect(result).toHaveLength(1);
      // MessageBubble 会将 system 消息路由为 hidden
      expect(routeMessageBubble(result[0])).toBe('hidden');
    });
  });

  // ---- Decision Table: assistant 消息的显示条件 ----

  describe('Decision Table: assistant 显示条件', () => {
    // | content   | trim后非空 | toolCalls | 显示? |
    // |-----------|-----------|-----------|-------|
    // | 有文本     | Yes       | []        | Yes   |
    // | 有文本     | Yes       | [有]      | Yes   |
    // | ""        | No        | [有]      | Yes   |
    // | ""        | No        | []        | No    |
    // | "  \n"    | No        | []        | No    |
    // | "  \n"    | No        | [有]      | Yes   |

    const cases = [
      { content: '有文本', toolCalls: undefined, expected: true, desc: '有内容无工具' },
      { content: '有文本', toolCalls: [{ id: '1', name: 'bash' }], expected: true, desc: '有内容有工具' },
      { content: '', toolCalls: [{ id: '1', name: 'bash' }], expected: true, desc: '空内容有工具' },
      { content: '', toolCalls: undefined, expected: false, desc: '空内容无工具' },
      { content: '  \n', toolCalls: undefined, expected: false, desc: '空白内容无工具' },
      { content: '  \n', toolCalls: [{ id: '1', name: 'bash' }], expected: true, desc: '空白内容有工具' },
    ];

    cases.forEach(({ content, toolCalls, expected, desc }) => {
      it(`${desc} → ${expected ? '显示' : '隐藏'}`, () => {
        const result = filterMessages([
          { role: 'assistant', content, toolCalls },
        ]);
        expect(result.length > 0).toBe(expected);
      });
    });
  });

  // ---- 特殊属性 ----

  describe('特殊属性: isMeta 和 compaction', () => {
    it('isMeta=true → 任何角色都隐藏', () => {
      const result = filterMessages([
        { role: 'user', content: '系统消息', isMeta: true },
        { role: 'assistant', content: '系统回复', isMeta: true },
      ]);
      expect(result).toHaveLength(0);
    });

    it('compaction 消息 → 始终显示（即使其他属性不合格）', () => {
      const result = filterMessages([
        {
          role: 'assistant',
          content: '',
          compaction: { compactedMessageCount: 10, compactedTokenCount: 5000, content: '摘要...' },
        },
      ]);
      expect(result).toHaveLength(1);
    });

    it('compaction 优先级高于 isMeta', () => {
      const result = filterMessages([
        {
          role: 'assistant',
          content: '',
          isMeta: true,
          compaction: { compactedMessageCount: 5, compactedTokenCount: 2000, content: '...' },
        },
      ]);
      // compaction 检查在 isMeta 之前，所以始终显示
      expect(result).toHaveLength(1);
    });
  });

  // ---- BVA: 消息数量边界 ----

  describe('BVA: 消息数量', () => {
    it('空消息列表 → 空结果', () => {
      expect(filterMessages([])).toHaveLength(0);
    });

    it('单条 user 消息', () => {
      expect(filterMessages([{ role: 'user', content: '问题' }])).toHaveLength(1);
    });

    it('典型对话: user→assistant 交替', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '问题1' },
        { role: 'assistant', content: '回答1' },
        { role: 'user', content: '问题2' },
        { role: 'assistant', content: '回答2' },
      ];
      expect(filterMessages(messages)).toHaveLength(4);
    });

    it('复杂对话: 混合所有角色', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '帮我读文件' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file' }] }, // 显示
        { role: 'tool', content: '文件内容...' },                                         // 隐藏
        { role: 'assistant', content: '文件内容如下：...' },                                // 显示
        { role: 'assistant', content: '', isMeta: true },                                  // 隐藏
      ];
      const result = filterMessages(messages);
      expect(result).toHaveLength(3); // user + assistant(工具调用) + assistant(回复)
    });
  });

  // ---- 实际场景: Channel 消息回复链路 ----

  describe('实际场景: Channel 消息回复后的 UI 渲染', () => {
    it('正常回复: 用户消息 + 工具调用 + 最终回复 → 显示 3 条', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '帮我分析这个数据' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_xlsx' }] },
        { role: 'tool', content: '{"rows": 100}' },
        { role: 'assistant', content: '分析完成，共 100 行数据...' },
      ];
      const result = filterMessages(messages);
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('user');
      expect(result[1].toolCalls).toBeDefined();
      expect(result[2].content).toContain('分析完成');
    });

    it('无回复场景: agent 只执行工具不产生文本 → 只显示 user + 工具调用', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '执行脚本' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'bash' }] },
        { role: 'tool', content: '执行完毕' },
        { role: 'assistant', content: '' },  // 空回复 → 隐藏
      ];
      const result = filterMessages(messages);
      expect(result).toHaveLength(2); // user + assistant(工具调用)
    });

    it('错误消息也显示 (有内容)', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '处理失败: Model timeout' },
      ];
      const result = filterMessages(messages);
      expect(result).toHaveLength(2);
      expect(result[1].content).toContain('处理失败');
    });
  });
});

describe('MessageBubble 路由逻辑', () => {

  it('compaction → compaction 组件', () => {
    expect(routeMessageBubble({
      role: 'assistant',
      content: '',
      compaction: { compactedMessageCount: 10, compactedTokenCount: 5000, content: '...' },
    })).toBe('compaction');
  });

  it('skill source → skill 组件', () => {
    expect(routeMessageBubble({
      role: 'assistant',
      content: 'Skill 执行中...',
      source: 'skill',
    })).toBe('skill');
  });

  it('system → hidden', () => {
    expect(routeMessageBubble({
      role: 'system' as 'system',
      content: 'nudge',
    })).toBe('hidden');
  });

  it('user → user 组件', () => {
    expect(routeMessageBubble({
      role: 'user',
      content: '问题',
    })).toBe('user');
  });

  it('assistant → assistant 组件', () => {
    expect(routeMessageBubble({
      role: 'assistant',
      content: '回复',
    })).toBe('assistant');
  });

  it('tool → assistant 组件 (fallback)', () => {
    // tool 消息在 filter 阶段就被移除了，但如果泄露到 MessageBubble 会走 assistant 分支
    expect(routeMessageBubble({
      role: 'tool',
      content: '结果',
    })).toBe('assistant');
  });
});
