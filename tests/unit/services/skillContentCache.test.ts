import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const db = vi.hoisted(() => ({ instance: null as unknown }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    getDb: () => db.instance,
  }),
}));

import { SkillContentCache, hashSkillContent } from '../../../src/host/telemetry/skillContentCache';

describe('skill content provenance (P2-1)', () => {
  it('hash 对内容敏感：同名不同内容必然可区分（这就是要治的病）', () => {
    const v1 = hashSkillContent('# skill v1\ndo the thing');
    const v2 = hashSkillContent('# skill v1\ndo the thing DIFFERENTLY');
    expect(v1).toHaveLength(16);
    expect(v1).not.toBe(v2);
    expect(hashSkillContent('# skill v1\ndo the thing')).toBe(v1); // 确定性
  });

  it('store/get 全文回溯（同 hash 去重不覆盖）', () => {
    db.instance = new Database(':memory:');
    const cache = new (SkillContentCache as unknown as new () => SkillContentCache)();
    cache.ensureTable();

    const hash = hashSkillContent('content-a');
    cache.store(hash, 'my-skill', 'content-a');
    cache.store(hash, 'my-skill', 'content-b-should-not-overwrite');

    expect(cache.get(hash)).toEqual({ skillName: 'my-skill', content: 'content-a' });
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('skill 调用路径真接了 hash（消息标签 + 落库调用都在）', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/host/tools/modules/skill/skill.ts'),
      'utf-8',
    );
    expect(source).toContain('<command-content-hash>');
    expect(source).toContain('getSkillContentCache().store(');
    expect(source).toContain('hashSkillContent(skill.promptContent)');
  });
});
