// ============================================================================
// design-canvas-session marker 历史残留清理迁移（2a #5）
//
// 背景：R1 会话化早期构建有一处缺陷把 design-canvas-session 引导 marker 漏进了
// messages.content（正确行为是只服务端按轮注入、不进 content）。当前代码已不漏；
// 本迁移一次性剥离历史残留行里的 marker 块，保留 marker 之后的真实文本。
//
// 断言：纯剥离函数各形态正确 + 迁移落库 + 幂等 + best-effort。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3'); // 全局 setup mock 了 better-sqlite3，本测试需真实模块建内存库
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  stripDesignCanvasSessionMarker,
  applyDesignCanvasMarkerCleanup,
} from '../../../../../src/main/services/core/database/migrations';

const MARKER =
  '<system-reminder kind="design-canvas-session">\n' +
  '你正在一个「设计画布」协作会话中，右侧画布是与用户共同迭代的产物面（画布当前为空）。\n' +
  '要在画布上创建或修改任何视觉内容，必须调用 ProposeCanvasOps。\n' +
  '</system-reminder>';

function makeLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Parameters<typeof applyDesignCanvasMarkerCleanup>[1];
}

function seedDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, content TEXT NOT NULL)');
  return db;
}

describe('stripDesignCanvasSessionMarker（纯剥离）', () => {
  it('用户行：marker 块 + 空行 + 真实文本 → 只留真实文本', () => {
    const content = `${MARKER}\n\n做张深蓝科技风主视觉`;
    expect(stripDesignCanvasSessionMarker(content)).toBe('做张深蓝科技风主视觉');
  });

  it('嵌入行：marker 夹在 failed-run-continuation 中间 → 剥块保留上下文', () => {
    const content =
      '<failed-run-continuation-context>\n上一轮失败。\n失败轮用户请求：' +
      `${MARKER}\n\n用通义万相出图`;
    expect(stripDesignCanvasSessionMarker(content)).toBe(
      '<failed-run-continuation-context>\n上一轮失败。\n失败轮用户请求：用通义万相出图',
    );
  });

  it('干净内容（无 marker）→ 原样不动', () => {
    const clean = '做一个落地页，深色科技风';
    expect(stripDesignCanvasSessionMarker(clean)).toBe(clean);
  });

  it('多个 marker 块 → 全部剥离', () => {
    const content = `${MARKER}\n${MARKER}\n收尾文本`;
    expect(stripDesignCanvasSessionMarker(content)).toBe('收尾文本');
  });

  it('畸形（有起始无闭合）→ 不动（best-effort，不误伤）', () => {
    const malformed = '<system-reminder kind="design-canvas-session">\n没有闭合标签的残片';
    expect(stripDesignCanvasSessionMarker(malformed)).toBe(malformed);
  });

  it('marker 文本随构建版本变化也能剥（按稳定定界符匹配，非全文）', () => {
    const oldText =
      '<system-reminder kind="design-canvas-session">旧版引导文案，措辞完全不同</system-reminder>\n\n真实请求';
    expect(stripDesignCanvasSessionMarker(oldText)).toBe('真实请求');
  });
});

describe('applyDesignCanvasMarkerCleanup（迁移落库）', () => {
  it('剥离污染行、不动干净行，按 id 精确更新', () => {
    const db = seedDb();
    const insert = db.prepare('INSERT INTO messages (id, role, content) VALUES (?, ?, ?)');
    insert.run('u1', 'user', `${MARKER}\n\n做张主视觉`);
    insert.run('s1', 'system', `<failed-run-continuation-context>\n失败轮用户请求：${MARKER}\n\n续编`);
    insert.run('c1', 'user', '普通请求，无 marker');

    applyDesignCanvasMarkerCleanup(db, makeLogger());

    const get = db.prepare('SELECT content FROM messages WHERE id = ?');
    expect((get.get('u1') as { content: string }).content).toBe('做张主视觉');
    expect((get.get('s1') as { content: string }).content).toBe(
      '<failed-run-continuation-context>\n失败轮用户请求：续编',
    );
    expect((get.get('c1') as { content: string }).content).toBe('普通请求，无 marker');
    db.close();
  });

  it('幂等：再跑一次不再改动（无残留 marker）', () => {
    const db = seedDb();
    db.prepare('INSERT INTO messages (id, role, content) VALUES (?, ?, ?)').run('u1', 'user', `${MARKER}\n\nX`);

    applyDesignCanvasMarkerCleanup(db, makeLogger());
    const after1 = (db.prepare('SELECT content FROM messages WHERE id = ?').get('u1') as { content: string }).content;
    applyDesignCanvasMarkerCleanup(db, makeLogger());
    const after2 = (db.prepare('SELECT content FROM messages WHERE id = ?').get('u1') as { content: string }).content;

    expect(after1).toBe('X');
    expect(after2).toBe('X');
    db.close();
  });

  it('无污染行时安全 no-op', () => {
    const db = seedDb();
    db.prepare('INSERT INTO messages (id, role, content) VALUES (?, ?, ?)').run('c1', 'user', '干净');
    expect(() => applyDesignCanvasMarkerCleanup(db, makeLogger())).not.toThrow();
    expect((db.prepare('SELECT content FROM messages WHERE id = ?').get('c1') as { content: string }).content).toBe('干净');
    db.close();
  });
});
