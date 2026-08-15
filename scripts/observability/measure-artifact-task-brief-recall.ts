#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { needsArtifactTaskBrief } from '../../src/host/prompts/artifactGeneration';

type UserRow = {
  sessionId: string;
  timestamp: number;
  rowId: number;
  content: string;
};

type WriteRow = {
  sessionId: string;
  timestamp: number;
  rowId: number;
  filePath: string;
};

type Turn = UserRow & {
  filePaths: string[];
};

type DeduplicatedTurn = {
  content: string;
  filePaths: Set<string>;
};

const DEFAULT_DATABASES = [
  '~/.code-agent/code-agent.db',
  '~/.code-agent-dev/code-agent.db',
];

const WRITE_TOOL_NAMES = ['write', 'write_file', 'append', 'append_file', 'edit', 'edit_file', 'multiedit'];
const ARTIFACT_EXTENSION = /\.(?:html?|md|markdown|csv|xlsx?|pptx?|docx?|pdf|png|jpe?g|gif|webp|svg)$/i;
const HTML_EXTENSION = /\.html?$/i;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

const LEGACY_ARTIFACT_TASK_BRIEF = /\b(create|generate|build|make|design|implement|write|develop)\b|生成|创建|制作|做个|做一个|写一个|实现一个|设计一个|搭一个|开发|开发一个/i;
const LEGACY_REPAIR_INTENT = /\b(fix|repair|patch|correct|debug|validate|verify|restore|update)\b|修复|修正|改好|验证|校验|失败|不通过|报错/i;
const LEGACY_ARTIFACT_TARGET = /\b\w[\w.-]*\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)\b|\/[\w .@-]+\/[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)|\\[\w .@-]+\\[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)/i;

function legacyNeedsArtifactTaskBrief(message: string): boolean {
  return LEGACY_ARTIFACT_TASK_BRIEF.test(message)
    || (LEGACY_REPAIR_INTENT.test(message) && LEGACY_ARTIFACT_TARGET.test(message));
}

function expandHome(input: string): string {
  if (!input.startsWith('~/')) return resolve(input);
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required to expand database paths');
  return resolve(home, input.slice(2));
}

function queryJson<T>(databasePath: string, sql: string): T[] {
  const uri = `file:${databasePath}?mode=ro`;
  const output = execFileSync('sqlite3', ['-json', uri, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) as T[] : [];
}

function readDatabase(databasePath: string): { users: UserRow[]; writes: WriteRow[] } {
  const users = queryJson<UserRow>(databasePath, `
    SELECT
      session_id AS sessionId,
      timestamp,
      rowid AS rowId,
      content
    FROM messages
    WHERE role = 'user'
    ORDER BY session_id, timestamp, rowid
  `);

  const quotedToolNames = WRITE_TOOL_NAMES.map((name) => `'${name}'`).join(', ');
  const writes = queryJson<WriteRow>(databasePath, `
    SELECT
      m.session_id AS sessionId,
      m.timestamp,
      m.rowid AS rowId,
      COALESCE(
        json_extract(tool.value, '$.arguments.file_path'),
        CASE
          WHEN json_type(tool.value, '$.arguments') = 'text'
            THEN json_extract(json_extract(tool.value, '$.arguments'), '$.file_path')
        END
      ) AS filePath
    FROM messages AS m,
      json_each(
        CASE
          WHEN json_valid(m.tool_calls) AND json_type(m.tool_calls) = 'array' THEN m.tool_calls
          ELSE '[]'
        END
      ) AS tool
    WHERE lower(json_extract(tool.value, '$.name')) IN (${quotedToolNames})
      AND filePath IS NOT NULL
      AND filePath != ''
    ORDER BY m.session_id, m.timestamp, m.rowid
  `);

  return { users, writes };
}

function comparePosition(left: Pick<UserRow, 'timestamp' | 'rowId'>, right: Pick<UserRow, 'timestamp' | 'rowId'>): number {
  return left.timestamp - right.timestamp || left.rowId - right.rowId;
}

function buildTurns(users: UserRow[], writes: WriteRow[]): Turn[] {
  const writesBySession = new Map<string, WriteRow[]>();
  for (const write of writes) {
    const sessionWrites = writesBySession.get(write.sessionId) ?? [];
    sessionWrites.push(write);
    writesBySession.set(write.sessionId, sessionWrites);
  }

  const turns: Turn[] = [];
  for (let index = 0; index < users.length; index += 1) {
    const user = users[index];
    const nextUser = users[index + 1]?.sessionId === user.sessionId ? users[index + 1] : undefined;
    const filePaths = (writesBySession.get(user.sessionId) ?? [])
      .filter((write) => comparePosition(write, user) > 0 && (!nextUser || comparePosition(write, nextUser) < 0))
      .map((write) => write.filePath);
    turns.push({ ...user, filePaths });
  }
  return turns;
}

function deduplicateTurns(turns: Turn[]): DeduplicatedTurn[] {
  const byBody = new Map<string, DeduplicatedTurn>();
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) continue;
    if (byBody.has(content)) continue;
    byBody.set(content, { content, filePaths: new Set(turn.filePaths) });
  }
  return [...byBody.values()];
}

function isDelivery(turn: DeduplicatedTurn, extension: RegExp): boolean {
  return [...turn.filePaths].some((filePath) => extension.test(filePath));
}

function summarize(
  turns: DeduplicatedTurn[],
  predicate: (message: string) => boolean,
): { total: number; hits: number; recall: number } {
  const hits = turns.filter((turn) => predicate(turn.content)).length;
  return {
    total: turns.length,
    hits,
    recall: turns.length === 0 ? 0 : hits / turns.length,
  };
}

function formatMetric(metric: { total: number; hits: number; recall: number }): string {
  return `${metric.hits}/${metric.total} (${(metric.recall * 100).toFixed(1)}%)`;
}

function parseDatabases(): string[] {
  const databaseFlag = process.argv.indexOf('--db');
  if (databaseFlag === -1) return DEFAULT_DATABASES.map(expandHome);
  const values = process.argv.slice(databaseFlag + 1).filter((value) => !value.startsWith('--'));
  if (values.length === 0) throw new Error('--db requires at least one database path');
  return values.map(expandHome);
}

const databases = parseDatabases();
const loaded = databases.map(readDatabase);
const rawTurns = loaded.flatMap(({ users, writes }) => buildTurns(users, writes));
const deduplicatedTurns = deduplicateTurns(rawTurns);
const artifactTurns = deduplicatedTurns.filter((turn) => isDelivery(turn, ARTIFACT_EXTENSION));
const htmlTurns = artifactTurns.filter((turn) => isDelivery(turn, HTML_EXTENSION));
const markdownTurns = artifactTurns.filter((turn) => isDelivery(turn, MARKDOWN_EXTENSION));

const report = {
  databases,
  corpus: 'all turns currently present in the live databases',
  methodology: 'user turns ordered by session_id/timestamp; artifact truth from subsequent Write/Append/Edit file_path; keep first occurrence when exact-body deduplicating before metrics',
  rawUserTurns: rawTurns.length,
  deduplicatedUserTurns: deduplicatedTurns.length,
  artifactDeliveries: artifactTurns.length,
  htmlDeliveries: htmlTurns.length,
  markdownDeliveries: markdownTurns.length,
  baseline: {
    overall: summarize(artifactTurns, legacyNeedsArtifactTaskBrief),
    html: summarize(htmlTurns, legacyNeedsArtifactTaskBrief),
    markdown: summarize(markdownTurns, legacyNeedsArtifactTaskBrief),
  },
  current: {
    overall: summarize(artifactTurns, needsArtifactTaskBrief),
    html: summarize(htmlTurns, needsArtifactTaskBrief),
    markdown: summarize(markdownTurns, needsArtifactTaskBrief),
  },
  currentMisses: artifactTurns
    .filter((turn) => !needsArtifactTaskBrief(turn.content))
    .map((turn) => ({ content: turn.content, filePaths: [...turn.filePaths].filter((path) => ARTIFACT_EXTENSION.test(path)) })),
  falsePositiveRate: null,
  falsePositiveRateNote: 'Not measured: no clean negative set is available; a missing write is not proof that the request was non-artifact.',
  corpusCaveat: 'These databases are dominated by eval fixtures and self-tests rather than organic conversations. Recall describes this corpus and should be discounted when extrapolated to real users.',
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write([
    `Databases: ${databases.join(', ')}`,
    `Raw user turns: ${report.rawUserTurns}`,
    `Deduplicated user turns: ${report.deduplicatedUserTurns}`,
    `Artifact deliveries: ${report.artifactDeliveries}`,
    `Baseline overall: ${formatMetric(report.baseline.overall)}`,
    `Current overall: ${formatMetric(report.current.overall)}`,
    `Baseline HTML: ${formatMetric(report.baseline.html)}`,
    `Current HTML: ${formatMetric(report.current.html)}`,
    `Baseline Markdown: ${formatMetric(report.baseline.markdown)}`,
    `Current Markdown: ${formatMetric(report.current.markdown)}`,
    `Current misses: ${report.currentMisses.length}`,
    report.falsePositiveRateNote,
    report.corpusCaveat,
  ].join('\n') + '\n');
}
