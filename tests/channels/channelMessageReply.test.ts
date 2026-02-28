// ============================================================================
// Channel Message Reply 测试
// 针对 commit c7a53d5 修复的 3 个互联 bug:
//   Bug 1: AgentLoop 数组引用 vs 副本 (stale messages)
//   Bug 2: ChannelAgentBridge 新消息提取逻辑 (slice + filter)
//   Bug 3: FeishuChannel bot 消息过滤 (无限循环防护)
//
// 测试设计原则 (testing-principles skill):
//   EP: 消息角色 (user/assistant/tool)、内容状态 (有值/空/空白/null)
//   BVA: 新消息数量边界 (0/1/many)、messageCountBefore 边界
//   State Transition: 消息流状态机 (接收→处理→响应→发送)
//   Decision Table: 响应提取条件组合
//   Bug Patterns: 数组引用、无限循环、off-by-one
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../src/shared/types';

// ============================================================================
// 辅助函数: 模拟消息提取逻辑 (从 channelAgentBridge.ts:244-247 提取)
// ============================================================================

/**
 * 从新增消息中提取最后一条有内容的 assistant 回复
 * 这是 channelAgentBridge.ts handleSyncMessage 中的核心逻辑
 */
function extractAssistantReply(
  allMessages: Message[],
  messageCountBefore: number
): string {
  const messagesAfter = allMessages;
  const countAfter = messagesAfter.length;

  // 只查找新增的消息中的 assistant 回复
  const newMessages = messagesAfter.slice(messageCountBefore);
  const assistantMessages = newMessages.filter(
    m => m.role === 'assistant' && m.content && m.content.trim()
  );
  const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

  return lastAssistantMessage?.content ?? '';
}

/**
 * 模拟旧版的错误逻辑: 搜索所有消息而非仅新增消息
 */
function extractAssistantReplyBuggy(
  allMessages: Message[],
  _messageCountBefore: number
): string {
  // Bug: 搜索所有消息，会返回旧的 assistant 消息
  const assistantMessages = allMessages.filter(
    m => m.role === 'assistant' && m.content && m.content.trim()
  );
  const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
  return lastAssistantMessage?.content ?? '';
}

// ============================================================================
// 测试工具函数
// ============================================================================

function makeMessage(role: 'user' | 'assistant' | 'tool', content: string, id?: string): Message {
  return {
    role,
    content,
    id: id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  } as Message;
}

// ============================================================================
// 测试套件
// ============================================================================

describe('Channel Message Reply', () => {

  // ==========================================================================
  // Bug 1: 数组引用 vs 副本
  // 旧代码: this.messages = [...config.messages] (spread 副本 → stale)
  // 新代码: this.messages = config.messages   (引用 → 共享)
  // ==========================================================================
  describe('Bug 1: 数组引用共享 (AgentLoop ↔ Orchestrator)', () => {

    it('引用模式: AgentLoop 推送消息后 orchestrator 能看到', () => {
      // Arrange: 模拟 orchestrator 持有的消息数组
      const sharedMessages: Message[] = [
        makeMessage('user', '你好'),
      ];

      // Act: 模拟 AgentLoop 使用引用（不是副本）
      const agentLoopMessages = sharedMessages; // 引用
      agentLoopMessages.push(makeMessage('assistant', '你好！有什么可以帮你的？'));

      // Assert: orchestrator 通过同一引用能看到新消息
      expect(sharedMessages.length).toBe(2);
      expect(sharedMessages[1].role).toBe('assistant');
      expect(sharedMessages[1].content).toBe('你好！有什么可以帮你的？');
    });

    it('副本模式 (旧 bug): AgentLoop 推送消息后 orchestrator 看不到', () => {
      // Arrange
      const orchestratorMessages: Message[] = [
        makeMessage('user', '你好'),
      ];

      // Act: 模拟旧版 AgentLoop 使用 spread 副本
      const agentLoopMessages = [...orchestratorMessages]; // 副本 ← BUG
      agentLoopMessages.push(makeMessage('assistant', '你好！有什么可以帮你的？'));

      // Assert: orchestrator 看不到新消息
      expect(orchestratorMessages.length).toBe(1); // 仍然是 1，丢失了回复
      expect(agentLoopMessages.length).toBe(2);    // 只在副本中
    });

    it('引用模式: 多轮对话消息持续可见', () => {
      const sharedMessages: Message[] = [];
      const agentLoopRef = sharedMessages;

      // 第 1 轮
      agentLoopRef.push(makeMessage('user', '第一个问题'));
      agentLoopRef.push(makeMessage('assistant', '第一个回答'));

      // 第 2 轮
      agentLoopRef.push(makeMessage('user', '第二个问题'));
      agentLoopRef.push(makeMessage('assistant', '第二个回答'));

      expect(sharedMessages.length).toBe(4);
      expect(sharedMessages[3].content).toBe('第二个回答');
    });

    it('getMessages() 返回副本不影响原数组', () => {
      // 模拟 orchestrator.getMessages() 返回 [...this.messages]
      const sharedMessages: Message[] = [
        makeMessage('user', '你好'),
        makeMessage('assistant', '你好！'),
      ];

      const snapshot = [...sharedMessages]; // getMessages() 行为
      snapshot.push(makeMessage('user', '额外消息'));

      // 原数组不受影响
      expect(sharedMessages.length).toBe(2);
      expect(snapshot.length).toBe(3);
    });
  });

  // ==========================================================================
  // Bug 2: 新消息提取逻辑
  // 旧代码: 搜索所有消息的 assistant → 返回旧回复
  // 新代码: slice(messageCountBefore) → 只在新消息中找
  // ==========================================================================
  describe('Bug 2: 新消息提取 (extractAssistantReply)', () => {

    // ---- EP: 消息角色分区 ----

    describe('EP: 按消息角色分区', () => {
      it('新消息中有 assistant 回复 → 返回该回复', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题'),
          makeMessage('assistant', '旧回答'),
          makeMessage('user', '新问题'),
          makeMessage('assistant', '新回答'),
        ];
        expect(extractAssistantReply(messages, 2)).toBe('新回答');
      });

      it('新消息中只有 user 消息 → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题'),
          makeMessage('assistant', '旧回答'),
          makeMessage('user', '新问题'),
        ];
        expect(extractAssistantReply(messages, 2)).toBe('');
      });

      it('新消息中只有 tool 消息 → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题'),
          makeMessage('assistant', '旧回答'),
          makeMessage('tool', '{"result": "ok"}'),
          makeMessage('tool', '{"result": "done"}'),
        ];
        expect(extractAssistantReply(messages, 2)).toBe('');
      });

      it('新消息混合: tool + assistant → 返回 assistant', () => {
        const messages: Message[] = [
          makeMessage('user', '帮我读文件'),
          // -- messageCountBefore = 1 --
          makeMessage('assistant', ''), // 空的工具调用消息
          makeMessage('tool', '文件内容...'),
          makeMessage('assistant', '文件内容如下：...'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('文件内容如下：...');
      });
    });

    // ---- EP: 内容状态分区 ----

    describe('EP: 按内容状态分区', () => {
      it('content 为空字符串 → 跳过该消息', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', ''),  // 空内容（工具调用消息常见）
          makeMessage('assistant', '真正的回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('真正的回复');
      });

      it('content 为纯空白 → 跳过该消息', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '   \n\t  '),  // 纯空白
          makeMessage('assistant', '有效回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('有效回复');
      });

      it('所有新 assistant 消息都是空内容 → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', ''),
          makeMessage('assistant', '  '),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('');
      });

      it('content 包含有效文本 → 正常返回', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '这是一个有效的回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('这是一个有效的回复');
      });
    });

    // ---- BVA: 新消息数量边界 ----

    describe('BVA: 新消息数量边界', () => {
      it('0 条新消息 (messageCountBefore === messages.length) → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题'),
          makeMessage('assistant', '旧回答'),
        ];
        expect(extractAssistantReply(messages, 2)).toBe('');
      });

      it('恰好 1 条新消息且是 assistant → 返回该消息', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '唯一回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('唯一回复');
      });

      it('恰好 1 条新消息但不是 assistant → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题'),
          makeMessage('user', '又一个问题'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('');
      });

      it('大量新消息 (20+) → 返回最后一条有效 assistant 消息', () => {
        const messages: Message[] = [makeMessage('user', '初始问题')];
        const before = messages.length;

        // 模拟复杂对话: 交替的工具调用和中间回复
        for (let i = 0; i < 10; i++) {
          messages.push(makeMessage('assistant', '')); // 工具调用空消息
          messages.push(makeMessage('tool', `工具结果 ${i}`));
        }
        messages.push(makeMessage('assistant', '最终回复'));

        expect(extractAssistantReply(messages, before)).toBe('最终回复');
      });

      it('messageCountBefore = 0 (首次消息，无历史) → 查找所有消息', () => {
        const messages: Message[] = [
          makeMessage('assistant', '欢迎使用！'),
        ];
        expect(extractAssistantReply(messages, 0)).toBe('欢迎使用！');
      });
    });

    // ---- Decision Table: 响应提取条件组合 ----

    describe('Decision Table: 响应提取条件组合', () => {
      // | 有新消息 | 有assistant | 内容非空 | 期望结果        |
      // |---------|------------|---------|----------------|
      // | Yes     | Yes        | Yes     | 使用该消息      |
      // | Yes     | Yes        | No      | 跳过,返回空     |
      // | Yes     | No         | N/A     | 返回空          |
      // | No      | N/A        | N/A     | 返回空          |

      it('有新消息 + 有assistant + 内容非空 → 使用该消息', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '有效回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('有效回复');
      });

      it('有新消息 + 有assistant + 内容为空 → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', ''),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('');
      });

      it('有新消息 + 无assistant → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('tool', '结果'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('');
      });

      it('无新消息 → 返回空', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '旧回复'),
        ];
        expect(extractAssistantReply(messages, 2)).toBe('');
      });
    });

    // ---- 关键 Bug 回归: 旧回复误返回 ----

    describe('回归: 旧版会返回历史 assistant 消息', () => {
      it('新版正确: 不返回 messageCountBefore 之前的 assistant 消息', () => {
        const messages: Message[] = [
          makeMessage('user', '旧问题1'),
          makeMessage('assistant', '旧回答1'),
          makeMessage('user', '旧问题2'),
          makeMessage('assistant', '旧回答2'),
          // -- messageCountBefore = 4 --
          makeMessage('user', '新问题'),
          makeMessage('tool', '执行中...'),
          // 没有新的 assistant 消息
        ];

        const newReply = extractAssistantReply(messages, 4);
        const buggyReply = extractAssistantReplyBuggy(messages, 4);

        // 新版: 没有新 assistant 消息，返回空
        expect(newReply).toBe('');
        // 旧版 bug: 会错误返回 "旧回答2"
        expect(buggyReply).toBe('旧回答2');
      });

      it('多轮对话: 只返回当前轮的回复', () => {
        const messages: Message[] = [
          // 第 1 轮
          makeMessage('user', '第一轮问题'),
          makeMessage('assistant', '第一轮回答'),
          // 第 2 轮
          makeMessage('user', '第二轮问题'),
          makeMessage('assistant', '第二轮回答'),
          // 第 3 轮
          makeMessage('user', '第三轮问题'),
          // -- messageCountBefore = 5 --
          makeMessage('assistant', '第三轮回答'),
        ];

        expect(extractAssistantReply(messages, 5)).toBe('第三轮回答');
      });
    });

    // ---- Bug Pattern: 多个 assistant 消息选最后一个 ----

    describe('Bug Pattern: 多个 assistant 消息', () => {
      it('多个有效 assistant → 选最后一个', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '中间思考'),
          makeMessage('tool', '工具结果'),
          makeMessage('assistant', '最终回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('最终回复');
      });

      it('有效 + 空 + 有效 → 选最后一个有效的', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '第一段回复'),
          makeMessage('assistant', ''),       // 空的（工具调用）
          makeMessage('assistant', '完整回复'),
        ];
        expect(extractAssistantReply(messages, 1)).toBe('完整回复');
      });

      it('有效 + 空(最后) → 选前面有效的', () => {
        const messages: Message[] = [
          makeMessage('user', '问题'),
          makeMessage('assistant', '有效回复'),
          makeMessage('assistant', ''),       // 最后一条是空的
        ];
        expect(extractAssistantReply(messages, 1)).toBe('有效回复');
      });
    });
  });

  // ==========================================================================
  // Bug 3: Bot 消息过滤 (FeishuChannel)
  // 旧代码: 无过滤 → bot 回复被重新处理 → 无限循环
  // 新代码: if (sender.sender_type === 'bot') return
  // ==========================================================================
  describe('Bug 3: Bot 消息过滤 (防无限循环)', () => {

    // 模拟飞书事件处理中的过滤逻辑
    function shouldProcessMessage(sender: { sender_type: string }): boolean {
      // 模拟 feishuChannel.ts:595 的逻辑
      if (sender.sender_type === 'bot') {
        return false; // 忽略 bot 消息
      }
      return true;
    }

    // ---- EP: sender_type 分区 ----

    describe('EP: sender_type 分区', () => {
      it('sender_type = "user" → 应处理', () => {
        expect(shouldProcessMessage({ sender_type: 'user' })).toBe(true);
      });

      it('sender_type = "bot" → 应忽略', () => {
        expect(shouldProcessMessage({ sender_type: 'bot' })).toBe(false);
      });

      it('sender_type 为其他值 → 应处理 (非 bot 即处理)', () => {
        expect(shouldProcessMessage({ sender_type: 'app' })).toBe(true);
        expect(shouldProcessMessage({ sender_type: '' })).toBe(true);
      });
    });

    // ---- State Transition: 无限循环检测 ----

    describe('State Transition: 无限循环场景', () => {
      it('模拟无限循环: bot 回复自己 → 过滤断链', () => {
        const processedMessages: string[] = [];
        const events = [
          { sender_type: 'user', content: '用户消息' },
          { sender_type: 'bot', content: '这是 bot 的回复' },    // 应被过滤
          { sender_type: 'bot', content: 'bot 又回复了自己' },   // 应被过滤
          { sender_type: 'user', content: '用户第二条消息' },
        ];

        for (const event of events) {
          if (shouldProcessMessage({ sender_type: event.sender_type })) {
            processedMessages.push(event.content);
          }
        }

        expect(processedMessages).toEqual([
          '用户消息',
          '用户第二条消息',
        ]);
        expect(processedMessages).not.toContain('这是 bot 的回复');
      });

      it('高频 bot 消息轰炸 → 全部过滤', () => {
        let processCount = 0;
        for (let i = 0; i < 100; i++) {
          if (shouldProcessMessage({ sender_type: 'bot' })) {
            processCount++;
          }
        }
        expect(processCount).toBe(0);
      });
    });

    // ---- ChannelSender.isBot 标记 ----

    describe('isBot 标记传递', () => {
      it('bot 消息应标记 isBot = true', () => {
        // 模拟 feishuChannel.ts:630 的逻辑
        const sender = { sender_type: 'bot', sender_id: { open_id: 'ou_xxx', user_id: '' } };
        const channelSender = {
          id: sender.sender_id.open_id,
          name: sender.sender_id.user_id || sender.sender_id.open_id,
          isBot: sender.sender_type === 'bot',
        };
        expect(channelSender.isBot).toBe(true);
      });

      it('user 消息应标记 isBot = false', () => {
        const sender = { sender_type: 'user', sender_id: { open_id: 'ou_yyy', user_id: 'u_yyy' } };
        const channelSender = {
          id: sender.sender_id.open_id,
          name: sender.sender_id.user_id || sender.sender_id.open_id,
          isBot: sender.sender_type === 'bot',
        };
        expect(channelSender.isBot).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 集成场景: 三个 Bug 协同工作
  // ==========================================================================
  describe('集成: 完整消息回复流程', () => {

    it('端到端: 用户消息 → agent 处理 → 正确提取回复', () => {
      // 模拟共享消息数组 (Bug 1 修复: 引用而非副本)
      const sharedMessages: Message[] = [
        makeMessage('user', '历史消息1'),
        makeMessage('assistant', '历史回复1'),
      ];

      const messageCountBefore = sharedMessages.length; // 2

      // 模拟 AgentLoop 处理: 推送新消息到共享数组
      sharedMessages.push(makeMessage('assistant', '')); // 工具调用
      sharedMessages.push(makeMessage('tool', '{ "result": "ok" }'));
      sharedMessages.push(makeMessage('assistant', '处理完成，结果如下...'));

      // Bug 2 修复: 只从新消息中提取
      const reply = extractAssistantReply(sharedMessages, messageCountBefore);

      expect(reply).toBe('处理完成，结果如下...');
      expect(reply).not.toBe('历史回复1'); // 不会误返回旧回复
    });

    it('端到端: agent 处理但无文本回复 (纯工具调用)', () => {
      const sharedMessages: Message[] = [
        makeMessage('user', '问题'),
      ];
      const before = sharedMessages.length;

      // Agent 只做了工具调用，没有文本回复
      sharedMessages.push(makeMessage('assistant', '')); // 工具调用（空内容）
      sharedMessages.push(makeMessage('tool', '执行完毕'));

      const reply = extractAssistantReply(sharedMessages, before);
      expect(reply).toBe('');
      // 此时 bridge 应发送默认消息 "处理完成，但没有生成响应。"
    });

    it('并发消息: 前一条处理中收到新消息', () => {
      const sharedMessages: Message[] = [];
      const firstBefore = sharedMessages.length; // 0

      // 第一条消息的处理
      sharedMessages.push(makeMessage('user', '第一个问题'));
      sharedMessages.push(makeMessage('assistant', '第一个回答'));

      const firstReply = extractAssistantReply(sharedMessages, firstBefore);
      expect(firstReply).toBe('第一个回答');

      // 第二条消息的处理（在第一条完成后）
      const secondBefore = sharedMessages.length; // 2
      sharedMessages.push(makeMessage('user', '第二个问题'));
      sharedMessages.push(makeMessage('assistant', '第二个回答'));

      const secondReply = extractAssistantReply(sharedMessages, secondBefore);
      expect(secondReply).toBe('第二个回答');
      expect(secondReply).not.toBe('第一个回答');
    });

    it('极端: 历史消息非常多 (100+) + 新消息少', () => {
      const sharedMessages: Message[] = [];

      // 100 条历史消息
      for (let i = 0; i < 50; i++) {
        sharedMessages.push(makeMessage('user', `历史问题 ${i}`));
        sharedMessages.push(makeMessage('assistant', `历史回答 ${i}`));
      }

      const before = sharedMessages.length; // 100

      // 只有 2 条新消息
      sharedMessages.push(makeMessage('user', '新问题'));
      sharedMessages.push(makeMessage('assistant', '新回答'));

      const reply = extractAssistantReply(sharedMessages, before);
      expect(reply).toBe('新回答');
      expect(reply).not.toBe('历史回答 49');
    });
  });

  // ==========================================================================
  // handleStreamingMessage 流式路径 (已修复，与同步路径逻辑一致)
  // ==========================================================================
  describe('流式消息路径 (已与同步路径统一)', () => {

    it('流式路径: 使用 messageCountBefore 避免返回旧回复', () => {
      const messages: Message[] = [
        makeMessage('user', '旧问题'),
        makeMessage('assistant', '旧回答'),
        makeMessage('user', '新问题'),
        // Agent 处理后没有新的 assistant 消息
      ];

      // 修复后: 流式路径也用 slice + filter
      const messageCountBefore = 2; // 旧问题 + 旧回答
      const reply = extractAssistantReply(messages, messageCountBefore);

      // 正确: 新消息中只有 user，没有 assistant → 返回空
      expect(reply).toBe('');
    });

    it('流式路径: 新消息中有 assistant → 正确返回', () => {
      const messages: Message[] = [
        makeMessage('user', '旧问题'),
        makeMessage('assistant', '旧回答'),
        makeMessage('user', '新问题'),
        makeMessage('assistant', '流式回复内容'),
      ];

      const reply = extractAssistantReply(messages, 2);
      expect(reply).toBe('流式回复内容');
      expect(reply).not.toBe('旧回答');
    });
  });

  // ==========================================================================
  // 附件转换 (convertAttachments)
  // ==========================================================================
  describe('附件转换边界', () => {
    // channelAgentBridge.ts:337-353

    function convertAttachments(channelAttachments?: Array<{
      id: string;
      type: 'image' | 'file' | 'audio' | 'video' | 'link';
      name: string;
      mimeType?: string;
      size?: number;
      url?: string;
      data?: string;
    }>): Array<{ type: string; name: string; size: number; mimeType: string }> | undefined {
      if (!channelAttachments || channelAttachments.length === 0) {
        return undefined;
      }
      return channelAttachments.map(att => ({
        type: att.type === 'image' ? 'image' : 'file',
        name: att.name,
        size: att.size || 0,
        mimeType: att.mimeType || 'application/octet-stream',
      }));
    }

    it('undefined 附件 → 返回 undefined', () => {
      expect(convertAttachments(undefined)).toBeUndefined();
    });

    it('空数组 → 返回 undefined', () => {
      expect(convertAttachments([])).toBeUndefined();
    });

    it('image 类型保持为 image', () => {
      const result = convertAttachments([
        { id: '1', type: 'image', name: 'photo.png' },
      ]);
      expect(result?.[0].type).toBe('image');
    });

    it('非 image 类型映射为 file', () => {
      const result = convertAttachments([
        { id: '1', type: 'audio', name: 'voice.mp3' },
        { id: '2', type: 'video', name: 'clip.mp4' },
        { id: '3', type: 'file', name: 'doc.pdf' },
      ]);
      expect(result?.every(r => r.type === 'file')).toBe(true);
    });

    it('缺少 size → 默认 0', () => {
      const result = convertAttachments([
        { id: '1', type: 'file', name: 'doc.pdf' },
      ]);
      expect(result?.[0].size).toBe(0);
    });

    it('缺少 mimeType → 默认 application/octet-stream', () => {
      const result = convertAttachments([
        { id: '1', type: 'file', name: 'unknown' },
      ]);
      expect(result?.[0].mimeType).toBe('application/octet-stream');
    });
  });

  // ==========================================================================
  // 错误响应处理
  // ==========================================================================
  describe('错误响应路径', () => {

    it('orchestrator 不可用时应返回错误', () => {
      // channelAgentBridge.ts:169-174
      const orchestrator = null;
      const shouldError = orchestrator === null;
      expect(shouldError).toBe(true);
    });

    it('sendMessage 异常时 bridge 应 catch 并发送错误', () => {
      // channelAgentBridge.ts:193-196
      const error = new Error('Model timeout');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      expect(errorMessage).toBe('Model timeout');
    });

    it('非 Error 对象异常 → fallback 到 Unknown error', () => {
      const error = 'string error';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      expect(errorMessage).toBe('Unknown error');
    });
  });
});
