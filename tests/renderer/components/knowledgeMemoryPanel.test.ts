import { describe, expect, it } from 'vitest';
import {
  buildAuditItems,
  buildInboxItems,
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
  });
});

