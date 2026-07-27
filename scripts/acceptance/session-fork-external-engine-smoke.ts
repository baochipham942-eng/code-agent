import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { Message } from '../../src/shared/contract/message';
import type { Session } from '../../src/shared/contract/session';
import type {
  ExternalAgentEngineKind,
  AgentEngineRunResult,
} from '../../src/shared/contract/agentEngine';

interface ExternalEngineAcceptanceInput {
  database: unknown;
  dbPath: string;
  templateSessionId: string;
  workspaceRoot: string;
  fakeHome: string;
  evidenceRoot: string;
  recordCheck: (condition: unknown, label: string, evidence?: unknown) => void;
}

interface ExternalEngineDatabase {
  createSession(session: Session): void;
  addMessage(sessionId: string, message: Message): void;
  getSession(sessionId: string): Session | null;
  getMessages(sessionId: string, limit?: number): Message[];
}

interface FakeEngineCapture {
  executable: string;
  argv: string[];
  cwd: string;
  stdin: string;
}

interface EngineEvidence {
  engine: ExternalAgentEngineKind;
  sourceSessionId: string;
  childSessionId: string;
  forkId: string;
  sourceDigest: string;
  payloadDigest: string;
  contextState: string;
  capturedPromptSha256: string;
  capturePath: string;
  externalSessionId: string;
  result: AgentEngineRunResult;
}

const EXTERNAL_ENGINES = ['codex_cli', 'claude_code'] as const;
const SOURCE_RUNTIME_IDENTITY = 'source-provider-runtime-must-never-be-copied';
const FIRST_PROMPT = 'acceptance first child prompt';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function conversation(prefix: string): Message[] {
  const timestamp = 1_888_888_888_888;
  return [
    { id: `${prefix}u1`, role: 'user', content: 'external user one', timestamp },
    { id: `${prefix}a1`, role: 'assistant', content: 'external assistant one', timestamp },
    { id: `${prefix}u2`, role: 'user', content: 'external user two', timestamp },
    { id: `${prefix}a2`, role: 'assistant', content: 'external assistant two', timestamp },
    { id: `${prefix}u3`, role: 'user', content: 'external user three', timestamp },
  ];
}

function fakeEngineProgram(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const executable = path.basename(process.argv[1]);
if (process.argv.includes('--version')) {
  process.stdout.write(executable + ' acceptance-fake 1.0.0\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const capture = {
    executable,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
  };
  fs.writeFileSync(
    path.join(__dirname, executable + '.capture.json'),
    JSON.stringify(capture, null, 2) + '\\n',
    'utf8',
  );
  if (executable === 'codex') {
    const outputIndex = process.argv.indexOf('--output-last-message');
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
      fs.writeFileSync(process.argv[outputIndex + 1], 'fake codex answer\\n', 'utf8');
    }
    process.stdout.write(JSON.stringify({
      type: 'thread.started',
      thread_id: 'codex-fresh-provider-session',
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'message.delta',
      delta: 'fake codex answer',
    }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'claude-fresh-provider-session',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'claude-fresh-provider-session',
    result: 'fake claude answer',
  }) + '\\n');
});
`;
}

async function installFakeEngines(root: string): Promise<string> {
  const fakeBin = path.join(root, 'fake-agent-engine-bin');
  await mkdir(fakeBin, { recursive: true });
  const program = fakeEngineProgram();
  await Promise.all(EXTERNAL_ENGINES.map(async (engine) => {
    const executable = engine === 'codex_cli' ? 'codex' : 'claude';
    const executablePath = path.join(fakeBin, executable);
    await writeFile(executablePath, program, { encoding: 'utf8', mode: 0o700 });
    await chmod(executablePath, 0o700);
  }));
  return fakeBin;
}

function scrubProviderEnvironment(fakeBin: string, fakeHome: string): void {
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
  process.env.HOME = fakeHome;
  delete process.env.CODEX_HOME;
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('ANTHROPIC_')
      || key.startsWith('CLAUDE_CODE_')
      || key.startsWith('CLAUDE_AI_')
      || /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CREDENTIAL)/i.test(key)
    ) {
      delete process.env[key];
    }
  }
}

function rawSourceDigest(dbPath: string, sessionId: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const messages = db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId);
    return sha256(stableJson({ session, messages }));
  } finally {
    db.close();
  }
}

function readContextHandoff(
  dbPath: string,
  forkId: string,
): { payloadDigest: string; state: string; attemptId: string | null } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`
      SELECT payload_digest, state, attempt_id
      FROM session_fork_context_handoffs
      WHERE fork_id = ?
      LIMIT 1
    `).get(forkId) as {
      payload_digest: string;
      state: string;
      attempt_id: string | null;
    } | undefined;
    if (!row) throw new Error(`missing context handoff for ${forkId}`);
    return {
      payloadDigest: row.payload_digest,
      state: row.state,
      attemptId: row.attempt_id,
    };
  } finally {
    db.close();
  }
}

async function runOneEngine(
  input: ExternalEngineAcceptanceInput,
  database: ExternalEngineDatabase,
  engine: ExternalAgentEngineKind,
  fakeBin: string,
): Promise<EngineEvidence> {
  const [
    { SessionForkService },
    {
      DEFAULT_EXTERNAL_FORK_CONTEXT_POLICY,
      SessionForkRuntimeContextService,
    },
    { CodexCliAdapter },
    { ClaudeCodeAdapter },
    { getAgentEngineRegistry },
  ] = await Promise.all([
    import('../../src/host/services/sessionFork/SessionForkService'),
    import('../../src/host/services/sessionFork/context/SessionForkRuntimeContextService'),
    import('../../src/host/services/agentEngine/codexCliAdapter'),
    import('../../src/host/services/agentEngine/claudeCodeAdapter'),
    import('../../src/host/services/agentEngine/agentEngineRegistry'),
  ]);

  const template = database.getSession(input.templateSessionId);
  if (!template) throw new Error(`template session ${input.templateSessionId} was not found`);
  const suffix = engine === 'codex_cli' ? 'codex' : 'claude';
  const sourceSessionId = `acceptance-${suffix}-source`;
  const createdAt = Date.now();
  database.createSession({
    id: sourceSessionId,
    userId: template.userId ?? null,
    title: `${suffix} external Fork source`,
    modelConfig: template.modelConfig,
    workingDirectory: input.workspaceRoot,
    projectId: template.projectId,
    engine: {
      kind: engine,
      runId: `${SOURCE_RUNTIME_IDENTITY}-${suffix}-run`,
      externalSessionId: `${SOURCE_RUNTIME_IDENTITY}-${suffix}-external`,
      logPath: `/private/${SOURCE_RUNTIME_IDENTITY}/${suffix}.log`,
      cwd: input.workspaceRoot,
      permissionProfile: 'read_only',
      origin: 'manual',
      updatedAt: createdAt,
    },
    memoryMode: template.memoryMode,
    suppressedMemoryEntryIds: template.suppressedMemoryEntryIds,
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
  });
  const messages = conversation(`${suffix}-`);
  messages.forEach((message) => database.addMessage(sourceSessionId, message));
  const sourceBefore = rawSourceDigest(input.dbPath, sourceSessionId);

  const forkService = new SessionForkService(
    input.database as ConstructorParameters<typeof SessionForkService>[0],
    {
      createId: (kind) => (
        kind === 'fork'
          ? `acceptance-${suffix}-fork`
          : `acceptance-${suffix}-child`
      ),
      ownerUserId: template.userId ?? null,
      getRuntimeStatus: () => 'idle',
    },
  );
  const fork = await forkService.createFork({
    sourceSessionId,
    anchorAssistantMessageId: `${suffix}-a2`,
    idempotencyKey: `acceptance-${suffix}-external-context`,
    workspaceMode: 'shared_current',
  });
  const childBeforeRun = database.getSession(fork.childSession.id);
  input.recordCheck(
    fork.lineage.contextDeliveryMode === 'validated_context_handoff'
      && childBeforeRun?.engine?.kind === engine
      && childBeforeRun.engine.runId === undefined
      && childBeforeRun.engine.externalSessionId === undefined
      && childBeforeRun.engine.logPath === undefined
      && childBeforeRun.engine.cwd === undefined,
    `${engine} Fork clears provider runtime identity before first child run`,
    { lineage: fork.lineage, childEngine: childBeforeRun?.engine },
  );

  const runtimeContextService = new SessionForkRuntimeContextService(
    input.database as ConstructorParameters<typeof SessionForkRuntimeContextService>[0],
    {
      createAttemptId: () => `acceptance-${suffix}-context-attempt`,
    },
  );
  const prepared = await runtimeContextService.prepareFirstChildRun({
    childSessionId: fork.childSession.id,
    engine,
    firstUserPrompt: FIRST_PROMPT,
    policy: DEFAULT_EXTERNAL_FORK_CONTEXT_POLICY,
  });
  if (!prepared) throw new Error(`${engine} did not prepare an external Fork context`);

  getAgentEngineRegistry().invalidate();
  const descriptor = await getAgentEngineRegistry().get(engine);
  input.recordCheck(
    descriptor.installState === 'installed'
      && descriptor.binaryPath?.startsWith(fakeBin),
    `${engine} acceptance uses the local fake executable`,
    { binaryPath: descriptor.binaryPath, version: descriptor.version },
  );

  const commonRequest = {
    sessionId: fork.childSession.id,
    prompt: FIRST_PROMPT,
    cwd: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    permissionProfile: 'read_only' as const,
    timeoutMs: 15_000,
    stallWarningMs: 10_000,
    forkContextHandoff: prepared.handoff,
    onForkContextDispatchStart: prepared.onDispatchStart,
    onForkContextDispatched: prepared.onDispatched,
  };
  const result = engine === 'codex_cli'
    ? await new CodexCliAdapter().run(commonRequest)
    : await new ClaudeCodeAdapter().run(commonRequest);
  input.recordCheck(
    result.status === 'completed'
      && result.outputText === `fake ${suffix} answer`,
    `${engine} adapter completes through a real child process`,
    result,
  );

  const capturePath = path.join(
    fakeBin,
    `${engine === 'codex_cli' ? 'codex' : 'claude'}.capture.json`,
  );
  const capture = JSON.parse(await readFile(capturePath, 'utf8')) as FakeEngineCapture;
  input.recordCheck(
    capture.cwd === input.workspaceRoot
      && capture.stdin.includes('external user one')
      && capture.stdin.includes('external assistant two')
      && capture.stdin.includes(FIRST_PROMPT)
      && capture.stdin.includes(prepared.handoff.sourcePrefixDigest)
      && !capture.stdin.includes(SOURCE_RUNTIME_IDENTITY)
      && !capture.argv.some((value) => value === '--resume' || value === 'resume'),
    `${engine} process receives the sealed prefix and new prompt without resume identity`,
    {
      cwd: capture.cwd,
      argv: capture.argv,
      stdinSha256: sha256(capture.stdin),
      sourcePrefixDigest: prepared.handoff.sourcePrefixDigest,
    },
  );

  const sourceAfter = rawSourceDigest(input.dbPath, sourceSessionId);
  input.recordCheck(
    sourceAfter === sourceBefore,
    `${engine} Fork and context dispatch leave the source session byte-stable`,
    { before: sourceBefore, after: sourceAfter },
  );
  const handoff = readContextHandoff(input.dbPath, fork.lineage.forkId);
  input.recordCheck(
    handoff.state === 'consumed'
      && handoff.payloadDigest === prepared.handoff.payloadDigest
      && handoff.attemptId === prepared.attemptId,
    `${engine} handoff records the exact consumed payload`,
    handoff,
  );

  const childAfterRun = database.getSession(fork.childSession.id);
  const expectedExternalSessionId = `${suffix}-fresh-provider-session`;
  input.recordCheck(
    childAfterRun?.engine?.externalSessionId === expectedExternalSessionId
      && childAfterRun.engine.externalSessionId !== `${SOURCE_RUNTIME_IDENTITY}-${suffix}-external`,
    `${engine} persists only the fresh child provider identity`,
    childAfterRun?.engine,
  );

  return {
    engine,
    sourceSessionId,
    childSessionId: fork.childSession.id,
    forkId: fork.lineage.forkId,
    sourceDigest: sourceAfter,
    payloadDigest: prepared.handoff.payloadDigest,
    contextState: handoff.state,
    capturedPromptSha256: sha256(capture.stdin),
    capturePath,
    externalSessionId: expectedExternalSessionId,
    result,
  };
}

export async function runExternalEngineProcessAcceptance(
  input: ExternalEngineAcceptanceInput,
): Promise<{ engines: EngineEvidence[]; fakeBin: string }> {
  const fakeBin = await installFakeEngines(input.evidenceRoot);
  scrubProviderEnvironment(fakeBin, input.fakeHome);
  const database = input.database as ExternalEngineDatabase;
  const engines: EngineEvidence[] = [];
  for (const engine of EXTERNAL_ENGINES) {
    engines.push(await runOneEngine(input, database, engine, fakeBin));
  }
  return { engines, fakeBin };
}
