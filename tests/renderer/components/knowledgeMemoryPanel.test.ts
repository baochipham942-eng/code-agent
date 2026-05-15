import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildAuditItems,
  buildInboxItems,
  buildMemoryInboxResolvePayload,
  hashInboxContent,
  KnowledgeInboxList,
  LightMemoryHealthPanel,
  MemoryInjectionTraceList,
} from '../../../src/renderer/components/features/knowledge/KnowledgeMemoryPanel';

describe('KnowledgeMemoryPanel projections', () => {
  it('groups memory audit rows with source, purpose, and injection evidence', () => {
    const auditItems = buildAuditItems({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [
        {
          filename: 'project_rules.md',
          name: 'Project Rules',
          description: 'Follow existing UI patterns',
          type: 'project',
          content: 'Use the left bottom menu.',
          updatedAt: '2026-05-13T12:00:00.000Z',
        },
      ],
      lightStats: {
        totalFiles: 1,
        byType: { project: 1 },
        sessionStats: null,
        recentConversations: [
          '- **2026-05-13**: "Memory audit" — Light Memory, seed-memory',
        ],
      },
      databaseMemories: [
        {
          id: 'mem-1',
          type: 'user_preference',
          category: 'preference',
          content: '用户偏好中文回复',
          summary: '中文回复',
          source: 'user_defined',
          projectPath: null,
          sessionId: null,
          confidence: 1,
          accessCount: 0,
          createdAt: 1778664000000,
          updatedAt: 1778664000000,
          lastAccessedAt: null,
          metadata: {},
        },
        {
          id: 'mem-2',
          type: 'project_knowledge',
          category: 'user_requirement',
          content: '入口必须放在左下角展开菜单栏里',
          summary: '左下角菜单入口',
          source: 'session_extracted',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 0.92,
          accessCount: 1,
          createdAt: 1778664100000,
          updatedAt: 1778664100000,
          lastAccessedAt: null,
          metadata: { flushEvent: 'preCompact' },
        },
      ],
      seedCandidates: [
        {
          id: 'mem-2',
          type: 'project_knowledge',
          category: 'user_requirement',
          content: '入口必须放在左下角展开菜单栏里',
          summary: '左下角菜单入口',
          source: 'session_extracted',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 0.92,
          accessCount: 1,
          createdAt: 1778664100000,
          updatedAt: 1778664100000,
          lastAccessedAt: null,
          metadata: { flushEvent: 'preCompact' },
        },
      ],
    });

    expect(auditItems.some((item) => item.category === 'user_preferences')).toBe(true);
    expect(auditItems.some((item) => item.category === 'project_rules')).toBe(true);
    expect(auditItems.some((item) => item.category === 'recent_topics')).toBe(true);
    expect(auditItems.some((item) => item.injection === 'memory-index')).toBe(true);
    expect(auditItems.some((item) => item.injection === 'recent-conversations')).toBe(true);

    const seedRow = auditItems.find((item) => item.injection === 'seed-candidate');
    expect(seedRow).toMatchObject({
      scope: '项目知识',
      source: expect.stringContaining('/repo/code-agent'),
    });
    expect(seedRow?.purpose).toContain('seed-memory');
  });

  it('builds inbox candidates from extracted session memories and recent conversations', () => {
    const inboxItems = buildInboxItems({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [],
      lightStats: {
        totalFiles: 0,
        byType: {},
        sessionStats: null,
        recentConversations: [
          '- **2026-05-13**: "Memory audit" — Light Memory, seed-memory',
        ],
      },
      databaseMemories: [
        {
          id: 'mem-2',
          type: 'project_knowledge',
          category: 'flush_decision',
          content: 'Knowledge 面板只读，不做 CRUD',
          summary: 'Knowledge 面板只读',
          source: 'session_extracted',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 0.9,
          accessCount: 0,
          createdAt: 1778664100000,
          updatedAt: 1778664100000,
          lastAccessedAt: null,
          metadata: {},
        },
      ],
      seedCandidates: [],
    });

    expect(inboxItems.map((item) => item.kind)).toContain('候选项目知识');
    expect(inboxItems.map((item) => item.kind)).toContain('会话结论');
    expect(inboxItems[0].source).toContain('压缩前提取');
    expect(inboxItems[0].reason).toContain('稳定项目知识');
    expect(inboxItems[0].content).toBe('Knowledge 面板只读，不做 CRUD');
  });

  it('hides inbox candidates that already have a user decision', () => {
    const inboxItems = buildInboxItems({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [],
      lightStats: {
        totalFiles: 0,
        byType: {},
        sessionStats: null,
        recentConversations: [],
      },
      databaseMemories: [
        {
          id: 'mem-2',
          type: 'project_knowledge',
          category: 'flush_decision',
          content: 'Knowledge Inbox 需要支持采纳和忽略',
          summary: 'Inbox 处理动作',
          source: 'session_extracted',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 0.9,
          accessCount: 0,
          createdAt: 1778664100000,
          updatedAt: 1778664100000,
          lastAccessedAt: null,
          metadata: {},
        },
        {
          id: 'mem-approved',
          type: 'project_knowledge',
          category: 'pattern',
          content: 'Approved pattern memory',
          summary: 'Approved pattern',
          source: 'user_defined',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 1,
          accessCount: 0,
          createdAt: 1778664200000,
          updatedAt: 1778664200000,
          lastAccessedAt: null,
          metadata: {
            knowledgeInbox: {
              candidateId: 'pattern:mem-approved',
              decision: 'approve',
            },
          },
        },
      ],
      seedCandidates: [],
      inboxDecisions: [
        {
          candidateId: 'flush:mem-2',
          decision: 'reject',
          contentHash: hashInboxContent('Knowledge Inbox 需要支持采纳和忽略'),
          title: 'Inbox 处理动作',
          kind: '候选项目知识',
          source: '压缩前提取',
          reason: '用户已忽略',
          decidedAt: 1778664300000,
          memoryId: null,
          decisionMemoryId: 'mem-decision',
        },
      ],
    });

    expect(inboxItems).toEqual([]);
  });

  it('hides recent conversation candidates by stable content hash', () => {
    const recentLine = '- **2026-05-13**: "Memory audit" — Light Memory, seed-memory';
    const inboxItems = buildInboxItems({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [],
      lightStats: {
        totalFiles: 0,
        byType: {},
        sessionStats: null,
        recentConversations: [recentLine],
      },
      databaseMemories: [],
      seedCandidates: [],
      inboxDecisions: [
        {
          candidateId: 'conversation:99',
          decision: 'reject',
          contentHash: hashInboxContent(recentLine.replace(/^- /, '').trim()),
          title: 'Memory audit',
          kind: '会话结论',
          source: '~/.code-agent/memory/recent-conversations.md',
          reason: '用户已忽略',
          decidedAt: 1778664300000,
          memoryId: null,
          decisionMemoryId: 'mem-decision',
        },
      ],
    });

    expect(inboxItems).toEqual([]);
  });

  it('builds resolve payloads with source, reason, and edited content', () => {
    const [item] = buildInboxItems({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [],
      lightStats: {
        totalFiles: 0,
        byType: {},
        sessionStats: null,
        recentConversations: [],
      },
      databaseMemories: [
        {
          id: 'mem-2',
          type: 'project_knowledge',
          category: 'flush_decision',
          content: 'Knowledge Inbox 需要支持采纳和忽略',
          summary: 'Inbox 处理动作',
          source: 'session_extracted',
          projectPath: '/repo/code-agent',
          sessionId: 'session-1',
          confidence: 0.9,
          accessCount: 0,
          createdAt: 1778664100000,
          updatedAt: 1778664100000,
          lastAccessedAt: null,
          metadata: {},
        },
      ],
      seedCandidates: [],
    });

    expect(buildMemoryInboxResolvePayload(item, 'approve', {
      content: '编辑后的知识',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
    })).toMatchObject({
      candidateId: 'flush:mem-2',
      decision: 'approve',
      content: '编辑后的知识',
      title: 'Inbox 处理动作',
      source: expect.stringContaining('压缩前提取'),
      reason: expect.stringContaining('稳定项目知识'),
      kind: '候选项目知识',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
    });
  });

  it('renders inbox action buttons, edit form, and item status', () => {
    const item = {
      id: 'flush:mem-2',
      contentHash: hashInboxContent('Knowledge Inbox 需要支持采纳和忽略'),
      kind: '候选项目知识' as const,
      title: 'Inbox 处理动作',
      summary: 'Knowledge Inbox 需要支持采纳和忽略',
      content: 'Knowledge Inbox 需要支持采纳和忽略',
      source: '压缩前提取 · /repo/code-agent · session session-1',
      reason: '压缩前识别为关键决策，需要用户后续确认是否沉淀成稳定项目知识。',
      updatedAt: 1778664100000,
    };

    const html = renderToStaticMarkup(
      React.createElement(KnowledgeInboxList, {
        items: [item],
        editingId: 'flush:mem-2',
        draftById: { 'flush:mem-2': '编辑后的知识' },
        statusById: { 'flush:mem-2': 'approving' },
        errorById: { 'flush:mem-2': 'Unknown action: memoryInboxResolve' },
        onApprove: () => {},
        onReject: () => {},
        onEdit: () => {},
        onDraftChange: () => {},
        onCancelEdit: () => {},
        onApproveEdit: () => {},
      }),
    );

    expect(html).toContain('采纳中');
    expect(html).toContain('保存采纳');
    expect(html).toContain('编辑后的知识');
    expect(html).toContain('Unknown action: memoryInboxResolve');

    const idleHtml = renderToStaticMarkup(
      React.createElement(KnowledgeInboxList, {
        items: [item],
        editingId: null,
        draftById: {},
        statusById: {},
        errorById: {},
        onApprove: () => {},
        onReject: () => {},
        onEdit: () => {},
        onDraftChange: () => {},
        onCancelEdit: () => {},
        onApproveEdit: () => {},
      }),
    );

    expect(idleHtml).toContain('采纳');
    expect(idleHtml).toContain('编辑采纳');
    expect(idleHtml).toContain('忽略');
  });

  it('renders Light Memory health issues and rebuild result', () => {
    const html = renderToStaticMarkup(
      React.createElement(LightMemoryHealthPanel, {
        health: {
          totalFiles: 3,
          indexExists: true,
          indexLineCount: 12,
          indexTooLong: false,
          missingInIndex: ['project_rules.md'],
          orphanInIndex: ['deleted.md'],
          invalidFrontmatter: [{ filename: 'broken.md', reason: 'missing description' }],
          unreadableFiles: [],
          duplicateNames: [],
          duplicateDescriptions: [],
        },
        rebuildResult: {
          indexPath: '/tmp/memory/INDEX.md',
          totalFiles: 3,
          indexedFiles: 2,
          skippedFiles: [{ filename: 'broken.md', reason: 'missing description' }],
        },
        isLoading: false,
        isRebuilding: false,
        onRebuild: () => {},
      }),
    );

    expect(html).toContain('Light Memory');
    expect(html).toContain('3 项');
    expect(html).toContain('未进索引: project_rules.md');
    expect(html).toContain('已索引 2/3');
  });

  it('renders injection traces without memory body content', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryInjectionTraceList, {
        traces: [
          {
            id: 'session-1:memory_index:1778665200000:0',
            blockType: 'memory_index',
            trigger: 'memory_intent',
            chars: 120,
            injected: true,
            source: 'light-memory-index',
            count: 3,
            timestamp: 1778665200000,
            sessionId: 'session-1',
          },
          {
            id: 'session-1:seed-memory:1778665300000:1',
            blockType: 'seed-memory',
            trigger: 'session_start_error',
            chars: 0,
            injected: false,
            source: 'database-seed',
            count: 0,
            timestamp: 1778665300000,
            sessionId: 'session-1',
          },
        ],
      }),
    );

    expect(html).toContain('Injection Trace');
    expect(html).toContain('memory_index');
    expect(html).toContain('已注入');
    expect(html).toContain('未注入');
    expect(html).not.toContain('Stored Memories');
  });
});
