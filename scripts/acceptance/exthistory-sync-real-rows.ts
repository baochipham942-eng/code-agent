#!/usr/bin/env npx tsx
// ============================================================================
// N-EXTHISTORY-SYNC-VIRTUAL-ROWS-VERIFY — 「保持聊天同步」真库落行验收
// ----------------------------------------------------------------------------
// 临时 HOME + 临时 CODE_AGENT_DATA_DIR + 真 SQLite（无 mock 仓库）：
//   off → setChatsSyncMode('on') → 数 sessions / messages / 台账；
//   经侧栏同一条宿主查询（SessionManager.listSessions）断言 origin / engine；
//   再跑一轮（幂等）→ off / paused 后行数不变、会话仍在列表。
// Run: npx tsx scripts/acceptance/exthistory-sync-real-rows.ts [--keep]
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Counts { sessions: number; messages: number; ledger: number }

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'exthistory-sync-rows-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.CODE_AGENT_HOME = home;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_WEB_MODE = 'true';
  const keep = process.argv.includes('--keep');

  const projDir = join(home, '.claude', 'projects', '-fake-proj');
  mkdirSync(projDir, { recursive: true });
  const base = Date.now() - 2 * 24 * 3600 * 1000;
  for (const [n, sid] of ['sync-real-a', 'sync-real-b'].entries()) {
    const t = (offset: number) => new Date(base + n * 60_000 + offset).toISOString();
    writeFileSync(join(projDir, `${sid}.jsonl`), [
      { type: 'user', uuid: `${sid}-u1`, sessionId: sid, timestamp: t(0), cwd: workspace, message: { content: [{ type: 'text', text: `session ${sid}: please read the config` }] } },
      { type: 'assistant', uuid: `${sid}-a1`, sessionId: sid, timestamp: t(1000), message: { content: [
        { type: 'text', text: 'Reading the config file.' },
        { type: 'tool_use', id: `toolu_${sid}`, name: 'Read', input: { file_path: '/tmp/config.json' } },
      ] } },
      { type: 'user', uuid: `${sid}-u2`, sessionId: sid, timestamp: t(2000), message: { content: [{ type: 'text', text: 'what does it say?' }] } },
      { type: 'assistant', uuid: `${sid}-a2`, sessionId: sid, timestamp: t(3000), message: { content: [{ type: 'text', text: 'It says hello.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  try {
    const { StandaloneAgentAdapter } = await import('../../src/host/testing/agentAdapter');
    await StandaloneAgentAdapter._ensureElectronMock();
    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const { getSessionManager } = await import('../../src/host/services/infra/sessionManager');
    const { setChatsSyncMode, runChatsAutoSync, getChatsSyncState } = await import('../../src/host/externalImport/chatsAutoSync');

    const database = getDatabase();
    await database.initialize();
    const raw = database.getDb();
    if (!raw) throw new Error('database handle missing');
    const count = (table: string): number => (raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    const counts = (): Counts => ({
      sessions: count('sessions'),
      messages: count('messages'),
      ledger: count('session_fork_portability_imports'),
    });
    const listed = async () => (await getSessionManager().listSessions({ includeArchived: true })) as unknown as Array<{ id: string; title: string; origin?: { kind?: string }; engine?: { kind?: string } }>;
    const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`ASSERT FAIL: ${msg}`); };
    const show = (label: string, c: Counts) => console.log(`${label}: sessions=${c.sessions} messages=${c.messages} ledger=${c.ledger}`);

    console.log(`temp HOME=${home} dataDir=${dataDir}`);
    const before = counts();
    show('initial (mode=' + getChatsSyncState().mode + ')', before);
    assert(getChatsSyncState().mode === 'off', 'initial mode off');
    assert(before.sessions === 0 && before.ledger === 0, 'empty DB at start');

    await setChatsSyncMode('on');
    const afterOn = counts();
    show('after setChatsSyncMode(on)', afterOn);
    assert(afterOn.sessions === 2, `2 sessions expected, got ${afterOn.sessions}`);
    assert(afterOn.messages > 0, 'messages > 0');
    assert(afterOn.ledger === 2, `2 ledger rows expected, got ${afterOn.ledger}`);
    console.log('lastRun=' + JSON.stringify(getChatsSyncState().lastRun));

    const items = await listed();
    const imported = items.filter((s) => s.origin?.kind === 'import');
    console.log(`session list: total=${items.length} importedByOrigin=${imported.length}`);
    for (const s of items) {
      console.log(JSON.stringify({ id: s.id, title: s.title, origin: s.origin, engine: s.engine }));
    }
    assert(items.length === 2 && imported.length === 2, 'both sessions listed with origin.kind=import');
    const labelOk = items.every((s) => s.origin?.kind === 'import' && s.engine?.kind === 'claude_code');
    console.log(`sidebar label condition (origin.kind==='import' && engine.kind==='claude_code') holds for all: ${labelOk}`);
    assert(labelOk, 'sidebar label condition');

    await runChatsAutoSync();
    const again = counts();
    show('after second runChatsAutoSync', again);
    assert(JSON.stringify(again) === JSON.stringify(afterOn), 'idempotent second run');

    await setChatsSyncMode('off');
    const afterOff = counts();
    show('after setChatsSyncMode(off)', afterOff);
    assert(JSON.stringify(afterOff) === JSON.stringify(afterOn), 'off keeps rows');
    assert((await listed()).filter((s) => s.origin?.kind === 'import').length === 2, 'imported still listed after off');

    await setChatsSyncMode('paused');
    const afterPaused = counts();
    show('after setChatsSyncMode(paused)', afterPaused);
    assert(JSON.stringify(afterPaused) === JSON.stringify(afterOn), 'paused keeps rows');
    assert((await listed()).filter((s) => s.origin?.kind === 'import').length === 2, 'imported still listed after paused');
    await runChatsAutoSync();
    assert(JSON.stringify(counts()) === JSON.stringify(afterOn), 'paused run is a no-op');

    console.log('=== EXTHISTORY SYNC REAL ROWS PASS ===');
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('=== EXTHISTORY SYNC REAL ROWS FAIL ===');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
