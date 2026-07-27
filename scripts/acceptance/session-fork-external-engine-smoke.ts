import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { Message } from '../../src/shared/contract/message';
import type { Session } from '../../src/shared/contract/session';
import type {
  ExternalAgentEngineKind,
} from '../../src/shared/contract/agentEngine';

interface ExternalEngineAcceptanceInput {
  database: unknown;
  dbPath: string;
  templateSessionId: string;
  workspaceRoot: string;
  fakeHome: string;
  fakeBin: string;
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
  envKeys: string[];
  forbiddenEnvKeys: string[];
  unsafeConfigPaths: string[];
}

interface EngineEvidence {
  engine: ExternalAgentEngineKind;
  surface: 'desktop' | 'web';
  sourceSessionId: string;
  childSessionId: string;
  forkId: string;
  sourceDigest: string;
  payloadDigest: string;
  contextState: string;
  capturedPromptSha256: string;
  capturePath: string;
  externalSessionId: string;
  firstFailure: {
    handoffState: string;
    externalSessionIdPersisted: boolean;
  };
  result: {
    status: 'completed';
    outputText: string;
  };
}

const EXTERNAL_ENGINES = ['codex_cli', 'claude_code'] as const;
const SOURCE_RUNTIME_IDENTITY = 'source-provider-runtime-must-never-be-copied';
const FIRST_PROMPT = 'acceptance first child prompt';
const SESSION_RELATED_TABLES = [
  'todos',
  'session_tasks',
  'session_task_events',
  'context_interventions',
  'session_runtime_state',
  'queued_inputs',
  'agent_wakes',
  'permission_decisions',
  'tool_execution_events',
  'durable_runs',
  'generative_ui_instances',
] as const;

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
  const timestamp = 1_700_000_000_000;
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
  fs.writeFileSync(
    path.join(__dirname, executable + '.version-probe.json'),
    JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env).sort() }) + '\\n',
    'utf8',
  );
  process.stdout.write(executable + ' acceptance-fake 1.0.0\\n');
  process.exit(0);
}
if (executable === 'codex' && process.argv.includes('debug') && process.argv.includes('models')) {
  process.stdout.write(JSON.stringify({
    models: [{ slug: 'gpt-5', display_name: 'Acceptance GPT-5' }],
  }) + '\\n');
  process.exit(0);
}
if (executable === 'claude' && process.argv.includes('--help')) {
  process.stdout.write("  --model <model> Model alias (e.g. 'sonnet', 'opus')\\n  --version\\n");
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
    envKeys: Object.keys(process.env).sort(),
    forbiddenEnvKeys: Object.keys(process.env).filter((key) =>
      /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|CREDENTIAL|SECRET)/i.test(key)
    ).sort(),
    unsafeConfigPaths: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .filter((key) => process.env[key] && !path.resolve(process.env[key]).startsWith(path.resolve(process.env.HOME) + path.sep)),
  };
  fs.writeFileSync(
    path.join(__dirname, executable + '.capture.json'),
    JSON.stringify(capture, null, 2) + '\\n',
    'utf8',
  );
  if (capture.forbiddenEnvKeys.length > 0 || capture.unsafeConfigPaths.length > 0) {
    process.stderr.write('acceptance fake rejected unsafe environment keys\\n');
    process.exit(72);
  }
  const failOncePath = path.join(__dirname, executable + '.fail-once');
  const failAfterIdentity = fs.existsSync(failOncePath);
  if (failAfterIdentity) fs.unlinkSync(failOncePath);
  if (executable === 'codex') {
    const outputIndex = process.argv.indexOf('--output-last-message');
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
      fs.writeFileSync(process.argv[outputIndex + 1], 'fake codex answer\\n', 'utf8');
    }
    process.stdout.write(JSON.stringify({
      type: 'thread.started',
      thread_id: 'codex-fresh-provider-session',
    }) + '\\n');
    if (failAfterIdentity) {
      process.stderr.write('acceptance fake failed after provider identity\\n');
      process.exit(73);
    }
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
  if (failAfterIdentity) {
    process.stderr.write('acceptance fake failed after provider identity\\n');
    process.exit(73);
  }
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

async function isolateProviderEnvironment(fakeBin: string, fakeHome: string): Promise<void> {
  const isolatedPaths = {
    CODEX_HOME: path.join(fakeHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(fakeHome, '.claude'),
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    XDG_DATA_HOME: path.join(fakeHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
  };
  await Promise.all(Object.values(isolatedPaths).map((directory) => (
    mkdir(directory, { recursive: true, mode: 0o700 })
  )));
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
  process.env.HOME = fakeHome;
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('NODE_')
      || key === 'ELECTRON_RUN_AS_NODE'
      || key.startsWith('ANTHROPIC_')
      || key.startsWith('CLAUDE_CODE_')
      || key.startsWith('CLAUDE_AI_')
      || /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|CREDENTIAL|SECRET)/i.test(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, isolatedPaths);
}

function rawSourceStateDigest(dbPath: string, sessionId: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const messages = db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId);
    const sidecars = Object.fromEntries(SESSION_RELATED_TABLES.map((table) => {
      const exists = db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
      `).get(table);
      if (!exists) return [table, []];
      const rows = db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(sessionId);
      return [table, rows.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))];
    }));
    return sha256(stableJson({ session, messages, sidecars }));
  } finally {
    db.close();
  }
}

async function workspaceDigest(root: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relativeDirectory && child.name === '.git') continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({
          path: relativePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
        });
      }
    }
  };
  await visit(root, '');
  return sha256(stableJson(entries));
}

async function assertExactAcceptanceBinding(
  input: ExternalEngineAcceptanceInput,
): Promise<void> {
  const [
    { getDatabase },
    { getLogsPath, getUserDataPath },
  ] = await Promise.all([
    import('../../src/host/services/core/databaseService'),
    import('../../src/host/platform'),
  ]);
  const expectedDataDir = path.dirname(path.resolve(input.dbPath));
  const expectedLogsPath = path.join(expectedDataDir, 'logs');
  input.recordCheck(
    getDatabase() === input.database
      && path.resolve(process.env.CODE_AGENT_DATA_DIR ?? '') === expectedDataDir
      && path.resolve(getUserDataPath()) === expectedDataDir
      && path.resolve(getLogsPath()) === expectedLogsPath,
    'external engine acceptance is bound to the exact isolated database and logs root',
    {
      databaseSingletonMatches: getDatabase() === input.database,
      configuredDataDir: process.env.CODE_AGENT_DATA_DIR,
      userDataPath: getUserDataPath(),
      logsPath: getLogsPath(),
      expectedDataDir,
    },
  );
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

async function armFakeEngineFailure(
  fakeBin: string,
  engine: ExternalAgentEngineKind,
): Promise<void> {
  const executable = engine === 'codex_cli' ? 'codex' : 'claude';
  await writeFile(path.join(fakeBin, `${executable}.fail-once`), 'fail after identity\n', 'utf8');
}

async function runDesktopProductTurn(input: {
  sessionId: string;
  workspaceRoot: string;
}): Promise<void> {
  const { AgentAppServiceImpl } = await import('../../src/host/app/agentAppService');
  const appService = new AgentAppServiceImpl(
    () => ({
      getOrCreateCurrentOrchestrator: () => ({
        getWorkingDirectory: () => input.workspaceRoot,
        setWorkingDirectory: () => undefined,
      }),
      emitAgentEventForSession: () => undefined,
    }) as never,
    () => null,
    () => input.sessionId,
    () => undefined,
  );
  await appService.sendMessage({
    sessionId: input.sessionId,
    content: FIRST_PROMPT,
    context: { workingDirectory: input.workspaceRoot },
  });
}

async function runWebProductTurn(input: {
  sessionId: string;
  workspaceRoot: string;
}): Promise<string> {
  const [
    { default: express },
    { createAgentRouter },
    { RunRegistry },
    { getSessionManager },
    { setDbAvailable },
  ] = await Promise.all([
    import('express'),
    import('../../src/web/routes/agent'),
    import('../../src/host/runtime/runRegistry'),
    import('../../src/host/services'),
    import('../../src/web/helpers/sessionCache'),
  ]);
  setDbAvailable(true);
  const runRegistry = new RunRegistry();
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry,
    pendingLocalToolCalls: new Map(),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    tryGetSessionManager: async () => getSessionManager(),
    tryGetCLISessionManager: async () => getSessionManager(),
    getSupabaseForSession: async () => null,
    getDurableRunRollout: () => ({
      policy: {
        mode: 'legacy',
        configuredValue: 'legacy',
        valid: true,
        durableActivation: false,
        durableReadPreference: false,
      },
      ready: true,
    }),
  } as Parameters<typeof createAgentRouter>[0]));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('external engine acceptance web route did not bind a TCP port');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: FIRST_PROMPT,
        sessionId: input.sessionId,
        context: { workingDirectory: input.workspaceRoot },
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`external engine acceptance web route failed with ${response.status}: ${body}`);
    }
    return body;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    runRegistry.clear();
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
    { getAgentEngineRegistry },
  ] = await Promise.all([
    import('../../src/host/services/sessionFork/SessionForkService'),
    import('../../src/host/services/sessionFork/context/SessionForkRuntimeContextService'),
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
  const sourceBefore = rawSourceStateDigest(input.dbPath, sourceSessionId);
  const workspaceBefore = await workspaceDigest(input.workspaceRoot);

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
      && childBeforeRun.engine.cwd === input.workspaceRoot,
    `${engine} Fork clears provider runtime identity while preserving the inherited cwd`,
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
  const expectedBinaryPath = await realpath(path.join(
    fakeBin,
    engine === 'codex_cli' ? 'codex' : 'claude',
  ));
  const detectedBinaryPath = descriptor.binaryPath
    ? await realpath(descriptor.binaryPath)
    : '';
  const [expectedBinaryStat, detectedBinaryStat] = descriptor.binaryPath
    ? await Promise.all([
        stat(expectedBinaryPath),
        stat(descriptor.binaryPath),
      ])
    : [null, null];
  input.recordCheck(
    descriptor.installState === 'installed'
      && detectedBinaryStat?.dev === expectedBinaryStat?.dev
      && detectedBinaryStat?.ino === expectedBinaryStat?.ino,
    `${engine} acceptance uses the local fake executable`,
    {
      installState: descriptor.installState,
      binaryPath: descriptor.binaryPath,
      detectedBinaryPath,
      expectedBinaryPath,
      detectedBinaryIdentity: detectedBinaryStat
        ? { dev: detectedBinaryStat.dev, ino: detectedBinaryStat.ino }
        : null,
      expectedBinaryIdentity: expectedBinaryStat
        ? { dev: expectedBinaryStat.dev, ino: expectedBinaryStat.ino }
        : null,
      version: descriptor.version,
      lastError: descriptor.lastError,
    },
  );

  const surface = engine === 'codex_cli' ? 'desktop' : 'web';
  const runProductTurn = surface === 'desktop'
    ? () => runDesktopProductTurn({
        sessionId: fork.childSession.id,
        workspaceRoot: input.workspaceRoot,
      })
    : () => runWebProductTurn({
        sessionId: fork.childSession.id,
        workspaceRoot: input.workspaceRoot,
      }).then(() => undefined);
  await armFakeEngineFailure(fakeBin, engine);
  await runProductTurn();
  const childAfterFailure = database.getSession(fork.childSession.id);
  const handoffAfterFailure = readContextHandoff(input.dbPath, fork.lineage.forkId);
  input.recordCheck(
    childAfterFailure?.engine?.externalSessionId === undefined
      && handoffAfterFailure.state === 'dispatching'
      && Boolean(handoffAfterFailure.attemptId),
    `${surface} ${engine} wiring does not persist an identity emitted by a failed provider run`,
    {
      childEngine: childAfterFailure?.engine,
      handoff: handoffAfterFailure,
    },
  );
  await runProductTurn();
  const completedMessages = database.getMessages(fork.childSession.id);
  const completedAssistant = completedMessages.find((message) => (
    message.role === 'assistant'
      && message.content.trim() === `fake ${suffix} answer`
  ));
  input.recordCheck(
    completedAssistant?.content.trim() === `fake ${suffix} answer`,
    `${surface} ${engine} wiring retries the same audited handoff through the real product entry point`,
    {
      messageId: completedAssistant?.id,
      content: completedAssistant?.content,
    },
  );

  const capturePath = path.join(
    fakeBin,
    `${engine === 'codex_cli' ? 'codex' : 'claude'}.capture.json`,
  );
  const capture = JSON.parse(await readFile(capturePath, 'utf8')) as FakeEngineCapture;
  const expectedMessages = [
    ['user', 'external user one'],
    ['assistant', 'external assistant one'],
    ['user', 'external user two'],
    ['assistant', 'external assistant two'],
  ];
  const actualMessages = prepared.handoff.messages.map((message) => [
    message.role,
    message.content,
  ]);
  const { composeExternalForkLaunchPrompt } = await import(
    '../../src/host/services/sessionFork/context/externalForkContextHandoff'
  );
  const expectedLaunchPrompt = composeExternalForkLaunchPrompt({
    engine,
    handoff: prepared.handoff,
    prompt: FIRST_PROMPT,
  });
  input.recordCheck(
    capture.cwd === input.workspaceRoot
      && stableJson(actualMessages) === stableJson(expectedMessages)
      && capture.stdin === expectedLaunchPrompt
      && !capture.stdin.includes('external user three')
      && !capture.stdin.includes(SOURCE_RUNTIME_IDENTITY)
      && !capture.argv.some((value) => value.toLowerCase().includes('resume'))
      && !stableJson(capture.argv).includes(SOURCE_RUNTIME_IDENTITY)
      && capture.forbiddenEnvKeys.length === 0
      && capture.unsafeConfigPaths.length === 0,
    `${engine} process receives exactly [u1,a1,u2,a2] and the new prompt in an isolated environment`,
    {
      cwd: capture.cwd,
      argv: capture.argv,
      messages: actualMessages,
      stdinSha256: sha256(capture.stdin),
      sourcePrefixDigest: prepared.handoff.sourcePrefixDigest,
      envKeys: capture.envKeys,
      forbiddenEnvKeys: capture.forbiddenEnvKeys,
      unsafeConfigPaths: capture.unsafeConfigPaths,
    },
  );

  const sourceAfter = rawSourceStateDigest(input.dbPath, sourceSessionId);
  const workspaceAfter = await workspaceDigest(input.workspaceRoot);
  input.recordCheck(
    sourceAfter === sourceBefore && workspaceAfter === workspaceBefore,
    `${engine} Fork and context dispatch leave source rows, runtime sidecars, and files byte-stable`,
    {
      sourceBefore,
      sourceAfter,
      workspaceBefore,
      workspaceAfter,
    },
  );
  const handoff = readContextHandoff(input.dbPath, fork.lineage.forkId);
  input.recordCheck(
    handoff.state === 'consumed'
      && handoff.payloadDigest === prepared.handoff.payloadDigest
      && handoff.attemptId === handoffAfterFailure.attemptId,
    `${engine} retry consumes the exact stable payload with the original durable attempt`,
    {
      preparedPayloadDigest: prepared.handoff.payloadDigest,
      failedAttempt: handoffAfterFailure,
      consumedAttempt: handoff,
    },
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
    surface,
    sourceSessionId,
    childSessionId: fork.childSession.id,
    forkId: fork.lineage.forkId,
    sourceDigest: sourceAfter,
    payloadDigest: prepared.handoff.payloadDigest,
    contextState: handoff.state,
    capturedPromptSha256: sha256(capture.stdin),
    capturePath,
    externalSessionId: expectedExternalSessionId,
    firstFailure: {
      handoffState: handoffAfterFailure.state,
      externalSessionIdPersisted: childAfterFailure?.engine?.externalSessionId !== undefined,
    },
    result: {
      status: 'completed',
      outputText: completedAssistant?.content.trim() ?? '',
    },
  };
}

export async function runExternalEngineProcessAcceptance(
  input: ExternalEngineAcceptanceInput,
): Promise<{ engines: EngineEvidence[]; fakeBin: string }> {
  await assertExactAcceptanceBinding(input);
  const database = input.database as ExternalEngineDatabase;
  const engines: EngineEvidence[] = [];
  for (const engine of EXTERNAL_ENGINES) {
    engines.push(await runOneEngine(input, database, engine, input.fakeBin));
  }
  return { engines, fakeBin: input.fakeBin };
}

export async function prepareExternalEngineAcceptanceEnvironment(input: {
  evidenceRoot: string;
  fakeHome: string;
}): Promise<{ fakeBin: string }> {
  const fakeBin = await installFakeEngines(input.evidenceRoot);
  await isolateProviderEnvironment(fakeBin, input.fakeHome);
  return { fakeBin };
}
