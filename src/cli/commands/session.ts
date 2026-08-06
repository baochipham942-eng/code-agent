import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { getUserConfigDir } from '../../host/config/configPaths';
import { ReadOnlySessionDatabase } from '../sessionDiagnostics/readOnlySessionDb';
import { buildFailureDigest, buildTimeline } from '../sessionDiagnostics/sessionQueries';
import { loadSessionPackageBuilder } from '../sessionDiagnostics/sessionPackageAdapter';
import { shortSessionIdForFileName } from '../../shared/utils/id';

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function wantsJson(options: { json?: boolean }, command: Command): boolean {
  return Boolean(options.json || command.optsWithGlobals().json);
}

function resolveDbPath(): string {
  return path.join(getUserConfigDir(), 'code-agent.db');
}

async function withReadonlyDb<T>(run: (db: ReadOnlySessionDatabase) => Promise<T> | T): Promise<T> {
  const db = new ReadOnlySessionDatabase(resolveDbPath());
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

const listCommand = new Command('list')
  .description('列出本机会话（只读）')
  .option('--json', '输出纯 JSON')
  .option('--project <path>', '只看指定项目路径')
  .option('--limit <n>', '最大条数', '20')
  .action(async (options: { json?: boolean; project?: string; limit: string }, command: Command) => {
    try {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('--limit 必须是 1 到 1000 的整数');
      }
      const sessions = await withReadonlyDb((db) => db.listSessions({
        project: options.project,
        limit,
      }));
      if (wantsJson(options, command)) {
        writeJson(sessions);
        return;
      }
      for (const session of sessions) {
        process.stdout.write(
          `${session.id}  ${formatDate(session.updatedAt)}  ${session.messageCount} messages  ${session.title}\n`,
        );
      }
    } catch (error) {
      fail(error);
    }
  });

const timelineCommand = new Command('timeline')
  .description('投影会话总账与 telemetry turn 边界（只读）')
  .argument('<id>', '会话 ID')
  .option('--json', '输出纯 JSON')
  .action(async (sessionId: string, options: { json?: boolean }, command: Command) => {
    try {
      const timeline = await withReadonlyDb((db) => {
        if (!db.getSession(sessionId)) throw new Error(`会话不存在: ${sessionId}`);
        return buildTimeline(db, sessionId, Date.now());
      });
      if (wantsJson(options, command)) {
        writeJson(timeline);
        return;
      }
      process.stdout.write(`Session ${timeline.sessionId}\n`);
      for (const entry of timeline.entries) {
        process.stdout.write(`${formatDate(entry.at)}  ${entry.lane.padEnd(9)}  ${entry.kind}  ${entry.summary}\n`);
      }
      process.stdout.write(`Telemetry turns: ${timeline.telemetryTurns.length}\n`);
    } catch (error) {
      fail(error);
    }
  });

const digestCommand = new Command('digest')
  .description('生成规则式 Failure Digest（只读，不调用模型）')
  .argument('<id>', '会话 ID')
  .option('--turn <turnId>', '只看指定 turn')
  .option('--json', '输出纯 JSON')
  .action(async (
    sessionId: string,
    options: { turn?: string; json?: boolean },
    command: Command,
  ) => {
    try {
      const digest = await withReadonlyDb((db) => {
        if (!db.getSession(sessionId)) throw new Error(`会话不存在: ${sessionId}`);
        return buildFailureDigest({ db, dataDir: getUserConfigDir(), sessionId, turnId: options.turn });
      });
      if (wantsJson(options, command)) {
        writeJson(digest);
        return;
      }
      process.stdout.write(`Session: ${digest.sessionId}\n`);
      process.stdout.write(`Happened: ${digest.happenedAt ? formatDate(digest.happenedAt) : '-'}\n`);
      process.stdout.write(`Error: ${digest.errorSummary ?? '未发现结构化错误'}\n`);
      process.stdout.write(`Permission denies: ${digest.permissionDenies}\n`);
      for (const tool of digest.lastTools) {
        process.stdout.write(`  ${tool.success ? 'ok' : 'fail'}  ${tool.name}${tool.error ? `  ${tool.error}` : ''}\n`);
      }
    } catch (error) {
      fail(error);
    }
  });

const exportCommand = new Command('export')
  .description('按需导出会话包或 transcript.jsonl（复用 spine packageBuilder）')
  .argument('<id>', '会话 ID')
  .option('--zip', '导出 zip 包')
  .option('--jsonl', '导出 transcript.jsonl')
  .option('--privacy <level>', 'shareable | full_local', 'shareable')
  .option('--out <dir>', '输出目录', path.join(os.homedir(), 'Downloads'))
  .action(async (sessionId: string, options: {
    zip?: boolean;
    jsonl?: boolean;
    privacy: string;
    out: string;
  }) => {
    try {
      if (options.zip && options.jsonl) throw new Error('--zip 与 --jsonl 只能选一个');
      if (!['shareable', 'full_local'].includes(options.privacy)) {
        throw new Error('--privacy 只支持 shareable 或 full_local');
      }
      await withReadonlyDb(async (db) => {
        if (!db.getSession(sessionId)) throw new Error(`会话不存在: ${sessionId}`);
        const spine = await loadSessionPackageBuilder();
        fs.mkdirSync(options.out, { recursive: true });
        if (options.jsonl) {
          const jsonl = await spine.buildSessionTranscriptJsonl(sessionId, {
            db: db.getNativeDatabase(),
            privacyLevel: options.privacy as 'shareable' | 'full_local',
          });
          const outputPath = path.join(
            options.out,
            `neo-session-${shortSessionIdForFileName(sessionId)}-transcript.jsonl`,
          );
          fs.writeFileSync(outputPath, jsonl, { mode: 0o600 });
          process.stdout.write(`${outputPath}\n`);
          return;
        }
        const result = await spine.buildSessionPackage(sessionId, {
          db: db.getNativeDatabase(),
          privacyLevel: options.privacy as 'shareable' | 'full_local',
        });
        const outputPath = path.join(options.out, result.suggestedFileName);
        fs.writeFileSync(outputPath, result.buffer, { mode: 0o600 });
        process.stdout.write(`${outputPath}\n`);
      });
    } catch (error) {
      fail(error);
    }
  });

export const sessionCommand = new Command('session')
  .description('查询和导出本机会话诊断数据')
  .addCommand(listCommand)
  .addCommand(timelineCommand)
  .addCommand(exportCommand)
  .addCommand(digestCommand);
