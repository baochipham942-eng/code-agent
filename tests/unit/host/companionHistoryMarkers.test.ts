import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { projectCompanionEvent } from '../../../src/host/services/companion/projectCompanionEvent';
import type { CompanionHistory } from '../../../src/shared/contract/companionLibrary';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

/**
 * 爸 2026-09-16 build 47 真机：会话里出现一条只写着 [cancelled] 的助手消息。
 * 引擎中断时把协议标记写进助手正文，桌面在渲染层消费，手机拿到的是原始正文。实时事件与历史读取两条路都要剥。
 */
const store = vi.hoisted(() => ({ db: null as unknown as import('better-sqlite3').Database }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => store.db, getSession: () => ({ id: 's1' }), listSessions: () => [], getProjectRepo: () => ({ listProjects: () => [] }) }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: () => ({ getCurrentUser: () => ({ id: 'owner-1' }) }) }));

import { CompanionLibraryService } from '../../../src/host/services/companion/CompanionLibraryService';

describe('中断协议标记不出手机边界', () => {
  it('实时事件：尾部标记剥掉；只剩标记的助手消息整条不发；用户原话不动', () => {
    expect(projectCompanionEvent('message', { id: 'a1', role: 'assistant', content: '写到一半\n\n[cancelled]' })).toEqual({ id: 'a1', role: 'assistant', content: '写到一半' });
    expect(projectCompanionEvent('message', { id: 'a2', role: 'assistant', content: '\n\n[cancelled]' })).toBeNull();
    for (const marker of ['[未完成 — 切换会话中断]', '[已被新消息打断]', '[连接中断 — 部分回答已保留]', '[生成中断 — 部分回答已保留]']) {
      expect(projectCompanionEvent('message', { id: 'a3', role: 'assistant', content: `前文\n\n${marker}` })).toMatchObject({ content: '前文' });
    }
    expect(projectCompanionEvent('message_snapshot', { content: '片段\n\n[cancelled]' })).toMatchObject({ content: '片段' });
    // 用户自己打的字不是协议标记
    expect(projectCompanionEvent('message', { id: 'u1', role: 'user', content: '[cancelled]' })).toMatchObject({ content: '[cancelled]' });
    // 空正文的助手消息（工具轮）照旧放行——只有「剥完才空」的才丢
    expect(projectCompanionEvent('message', { id: 'a4', role: 'assistant', content: '' })).toMatchObject({ content: '' });
  });

  it('历史读取：剥标记、只剩标记的行跳过，且分页照常收尾（不留一个永远的「加载更多」）', async () => {
    store.db = new Database(':memory:');
    try {
      applyTestSessionSchema(store.db);
      store.db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES ('s1', 't', 'p', 'm', 1, 1)`).run();
      const insert = store.db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)');
      insert.run('u1', 's1', 'user', '你好', 1);
      insert.run('a1', 's1', 'assistant', '\n\n[cancelled]', 2);
      insert.run('u2', 's1', 'user', '再试', 3);
      insert.run('a2', 's1', 'assistant', '好的\n\n[已被新消息打断]', 4);
      const gateway = new CompanionGateway(new Database(':memory:'));
      const service = new CompanionLibraryService(gateway, () => false);
      const history = await service.read('device', { kind: 'history', sessionId: 's1', offset: 0 }) as CompanionHistory;
      expect(history.messages.map(m => [m.id, m.content])).toEqual([['u1', '你好'], ['u2', '再试'], ['a2', '好的']]);
      expect(history.nextOffset).toBeNull();
    } finally { store.db.close(); }
  });
});
