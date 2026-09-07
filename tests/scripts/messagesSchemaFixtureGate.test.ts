// ============================================================================
// tests/ 里新写的 messages 建表语句必须红。
//
// 夹具应从 tests/utils/applyTestSessionSchema.ts 走生产 applySchema，
// 不要手抄 messages DDL（列集会跟 schema.ts 漂移）。
//
// 白名单只覆盖「有正当理由手写旧表」的迁移/兼容测试：
// - tests/unit/database/schemaConversationBranchMigration.test.ts
//   从旧 fork/rewind 投影迁到 conversation branch ledger；CREATE 必须是迁移前形状。
// - tests/unit/repositories/transcriptFts.test.ts
//   bare-schema 兼容块用 CLI 最小 messages 表，证明 applyTranscriptFtsSchema 列守卫。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../src/host/services/core/database/schema';
import { applyTestSessionSchema } from '../utils/applyTestSessionSchema';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

const WHITELIST = new Set([
  'tests/unit/database/schemaConversationBranchMigration.test.ts',
  'tests/unit/repositories/transcriptFts.test.ts',
]);

const HANDWRITTEN_MESSAGES_DDL =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?messages\b/i;

type Hit = { file: string; line: number; text: string };

function listTestFiles(root: string): string[] {
  const testsRoot = join(root, 'tests');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:[cm]?js|[cm]?ts|tsx)$/u.test(entry.name)) files.push(full);
    }
  };
  walk(testsRoot);
  return files;
}

function findHandwrittenMessagesCreateTable(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const abs of listTestFiles(root)) {
    const file = relative(root, abs).replaceAll('\\', '/');
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (HANDWRITTEN_MESSAGES_DDL.test(trimmed)) {
        hits.push({ file, line: index + 1, text: trimmed });
      }
    });
  }
  return hits;
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as Parameters<typeof applySchema>[1];

function messageColumns(db: InstanceType<typeof Database>): string[] {
  return (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
    .map((row) => row.name);
}

describe('messages schema fixture gate', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('whitelist files still contain handwritten messages DDL (anchor)', () => {
    const hits = findHandwrittenMessagesCreateTable(repoRoot);
    for (const file of WHITELIST) {
      expect(
        hits.some((hit) => hit.file === file),
        `白名单 ${file} 已不再手写 messages 表，从门文件白名单里删掉`,
      ).toBe(true);
    }
  });

  it('tests/ has no handwritten messages DDL outside the whitelist', () => {
    const stray = findHandwrittenMessagesCreateTable(repoRoot)
      .filter((hit) => !WHITELIST.has(hit.file));
    expect(
      stray,
      `tests/ 里新的手抄 messages DDL（改走 applyTestSessionSchema）：\n${stray
        .map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('flags a new handwritten messages CREATE TABLE outside the whitelist', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'msgschema-gate-'));
    const rogueRel = 'tests/unit/rogue-messages-ddl.test.ts';
    mkdirSync(join(tempRoot, 'tests/unit'), { recursive: true });
    writeFileSync(
      join(tempRoot, rogueRel),
      `${['CREATE TABLE', 'messages (id TEXT PRIMARY KEY);'].join(' ')}\n`,
    );
    const stray = findHandwrittenMessagesCreateTable(tempRoot)
      .filter((hit) => !WHITELIST.has(hit.file));
    expect(stray.map((hit) => hit.file)).toEqual([rogueRel]);
  });

  it('applyTestSessionSchema messages columns stay in lockstep with production applySchema', () => {
    const production = new Database(':memory:');
    const fixture = new Database(':memory:');
    try {
      applySchema(production, silentLogger);
      applyTestSessionSchema(fixture);
      expect(messageColumns(fixture)).toEqual(messageColumns(production));
    } finally {
      production.close();
      fixture.close();
    }
  });
});
