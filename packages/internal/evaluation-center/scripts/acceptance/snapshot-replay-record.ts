// N-SNAPSHOT-REGRESSION：snapshot-replay --record 的录制实现。单独成文件，
// 让默认回放模式不背 host 运行时的重 import（回放必须保持纯文件 + 纯函数，
// keyless、无 DB、无环境副作用）。
// 进程级 env（CODE_AGENT_DATA_DIR 等）由 CLI 在 import 本文件之前落定，见
// snapshot-replay.ts 头注；每用例的 READ/WRITE 夹具 env 在跑该用例前写入
// process.env（假模型在调用期读 env）。

import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import process from 'process';

import {
  buildSnapshotIdMap,
  buildSnapshotScrubRules,
  buildSnapshotTurnFiles,
  collectSnapshotBlobs,
  normalizeLedgerForSnapshot,
  normalizeManifestForSnapshot,
  replaySnapshotCase,
  scrubSnapshotRecording,
  serializeSnapshotJson,
  type SnapshotCaseIndex,
  type SnapshotManifest,
} from '../../src/host/evaluation/snapshotReplay';
import {
  SNAPSHOT_CASES,
  SNAPSHOT_READ_FIXTURE_MARKER,
  planSnapshotRecordLayout,
  snapshotFakeModelEnv,
} from '../lib/snapshot-replay-cases';

function fail(message: string, details?: unknown): never {
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`[snapshot-replay:record] ${message}${suffix}`);
}

async function listTraceFiles(traceDir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(traceDir));
  } catch {
    return new Set();
  }
}

export async function recordSnapshotCorpus(options: {
  corpusDir: string;
  dataDir: string;
  keepTmp: boolean;
}): Promise<void> {
  const repoRoot = process.cwd();
  const { dataDir } = options;
  const traceDir = path.join(dataDir, 'traces');
  const memoryDir = path.join(dataDir, 'memory');

  // 上一轮留下的只读 memory 目录要先还权限，否则 rm 不掉。
  await chmod(memoryDir, 0o755).catch(() => {});
  await rm(dataDir, { recursive: true, force: true });

  // 锁死 session-stats：recordSessionStart/End 的写会撞上只读目录被其 catch 吞掉，
  // loadStats 恒空 ⇒ <session_metadata> 块恒不注入系统提示词。该块含会话计数
  // （Total sessions N），注入时机与上一个 session 的落账存在竞争，跨次/跨机
  // 必然不同字节——2026-09-07 双录 diff 实测抓到，快照语料必须排掉它。
  await mkdir(memoryDir, { recursive: true });
  await chmod(memoryDir, 0o555);

  const { getProtocolRegistry } = await import('@host/tools/protocolRegistry');
  getProtocolRegistry();

  const { getDatabase } = await import('@host/services/core/databaseService');
  const testing = await import('@host/testing/index');
  const { getContentCache } = await import('@host/telemetry/contentCache');
  const { getSystemPromptCache } = await import('@host/telemetry/systemPromptCache');
  const { getToolSchemaCache } = await import('@host/telemetry/toolSchemaCache');

  const database = getDatabase();
  await database.initialize();

  const scrubRules = buildSnapshotScrubRules({ repoRoot, dataDir });
  const seenTraceFiles = new Set<string>();
  let recordedTurns = 0;

  for (const spec of SNAPSHOT_CASES) {
    const layout = planSnapshotRecordLayout(dataDir, spec.caseId);
    await mkdir(layout.workspaceDir, { recursive: true });
    await writeFile(
      layout.readFixturePath,
      [
        `${SNAPSHOT_READ_FIXTURE_MARKER}=true`,
        'This file proves the snapshot corpus session reached the real Read tool executor.',
      ].join('\n'),
      'utf8',
    );
    const fakeModelEnv = snapshotFakeModelEnv(layout);
    process.env.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE = fakeModelEnv.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE;
    process.env.CODE_AGENT_E2E_AGENT_MODEL_WRITE_FILE = fakeModelEnv.CODE_AGENT_E2E_AGENT_MODEL_WRITE_FILE;

    const adapter = new testing.StandaloneAgentAdapter({
      workingDirectory: layout.workspaceDir,
      persistLongTermMemory: false,
      includeRecentConversations: false,
      // 语料必须只含公开仓自己的 prompt/工具面：显式空技能集，不扫本机 ~/.claude。
      skills: [],
      modelConfig: {
        provider: 'openai',
        model: 'e2e-local-agent-model',
        apiKey: 'e2e-local',
      },
      toolMode: 'deferred',
      database,
    });

    const executedTools: string[] = [];
    for (const prompt of spec.prompts) {
      const result = await adapter.sendMessage(prompt);
      if (result.errors.length > 0) {
        fail(`用例 ${spec.caseId} 会话报错`, { prompt, errors: result.errors });
      }
      // toolExecutions 是单次 sendMessage 口径，用例级期望要跨 prompt 累计。
      executedTools.push(...result.toolExecutions.map((execution) => execution.tool));
      for (const execution of result.toolExecutions) {
        if (!execution.success) {
          fail(`用例 ${spec.caseId} 工具执行失败`, execution);
        }
      }
    }
    for (const tool of spec.expectedTools) {
      if (!executedTools.includes(tool)) {
        fail(`用例 ${spec.caseId} 没有真的执行 ${tool}`, { executedTools });
      }
    }

    // 一个用例一个新 session ⇒ traces 目录里新增的 test-*.jsonl 就是本条用例。
    // capability-runtime.jsonl 是跨 session 常驻文件且懒建（首个能力事件才出现），
    // 不能假定它在录制启动时已存在，直接按 session 前缀过滤。
    const traceFiles = await listTraceFiles(traceDir);
    const newFiles = [...traceFiles]
      .filter((file) => !seenTraceFiles.has(file) && file.startsWith('test-'))
      .sort();
    if (newFiles.length !== 1) {
      fail(`用例 ${spec.caseId} 应新增且只新增 1 个 session trace 文件`, { newFiles, traceDir });
    }
    for (const file of newFiles) seenTraceFiles.add(file);
    const traceRaw = await readFile(path.join(traceDir, newFiles[0]), 'utf8');
    const manifests: SnapshotManifest[] = traceRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data: SnapshotManifest })
      .filter((event) => event.type === 'request_manifest')
      .map((event) => event.data);
    if (manifests.length !== spec.expectedTurns) {
      fail(`用例 ${spec.caseId} manifest 数不符：期望 ${spec.expectedTurns}，实际 ${manifests.length}`);
    }
    const degraded = manifests.filter((manifest) => manifest.degraded);
    if (degraded.length > 0) {
      fail(`用例 ${spec.caseId} 出现 ${degraded.length} 轮 degraded manifest——语料必须健康`, degraded.map((m) => m.requestId));
    }

    const ledgerMessages = adapter.getTranscriptMessages();
    if (ledgerMessages.length === 0) fail(`用例 ${spec.caseId} 账本为空`);
    const idMap = buildSnapshotIdMap(ledgerMessages);
    const normalizedLedger = normalizeLedgerForSnapshot(ledgerMessages, idMap);

    const turns = manifests.map((_, index) => `turn-${String(index + 1).padStart(2, '0')}`);
    const index: SnapshotCaseIndex = {
      version: 1,
      caseId: spec.caseId,
      title: spec.title,
      coverage: spec.coverage,
      model: { provider: 'openai', model: 'e2e-local-agent-model' },
      fakeModelEnv,
      turns,
    };

    const normalizedManifests = manifests.map((manifest, turnIndex) => (
      normalizeManifestForSnapshot(manifest, idMap, `${spec.caseId}-request-${String(turnIndex + 1).padStart(2, '0')}`)
    ));
    const rawBlobs = collectSnapshotBlobs(normalizedManifests, {
      getContent: (hash) => getContentCache().get(hash),
      getSystemPrompt: (hash) => getSystemPromptCache().get(hash),
      getToolSchema: (hash) => getToolSchemaCache().get(hash),
    });

    // 脱敏擦洗：系统提示词 <env> 块的家目录、自我认知块的仓绝对路径不许进快照
    // （AGENTS.md §5.8）。擦洗后哈希全量重算回写，回放侧哈希自校验不受影响。
    const scrubbed = scrubSnapshotRecording({
      manifests: normalizedManifests,
      ledgerMessages: normalizedLedger,
      blobs: rawBlobs,
      fakeModelEnv,
      rules: scrubRules,
    });
    const scrubbedIndex: SnapshotCaseIndex = { ...index, fakeModelEnv: scrubbed.fakeModelEnv };

    const caseDir = path.join(options.corpusDir, spec.caseId);
    await rm(caseDir, { recursive: true, force: true });
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, 'index.json'), serializeSnapshotJson(scrubbedIndex), 'utf8');
    await writeFile(
      path.join(caseDir, 'ledger.json'),
      serializeSnapshotJson({ messages: scrubbed.ledgerMessages }),
      'utf8',
    );
    await writeFile(path.join(caseDir, 'blobs.json'), serializeSnapshotJson(scrubbed.blobs), 'utf8');

    for (const [turnIndex, manifest] of scrubbed.manifests.entries()) {
      const files = buildSnapshotTurnFiles(manifest, scrubbed.ledgerMessages, scrubbed.blobs, scrubbedIndex);
      const turnDir = path.join(caseDir, turns[turnIndex]);
      await mkdir(turnDir, { recursive: true });
      await writeFile(path.join(turnDir, 'manifest.json'), files.manifestRaw, 'utf8');
      await writeFile(path.join(turnDir, 'canonical-request.json'), files.canonicalRequestRaw, 'utf8');
      await writeFile(path.join(turnDir, 'expected-response.json'), files.expectedResponseRaw, 'utf8');
    }

    // 录制自验：落盘字节当场回放不过 = 规范化/白名单有病，不许带病入库。
    const selfCheck = replaySnapshotCase(caseDir);
    if (selfCheck.verified !== turns.length || selfCheck.skippedDegraded !== 0) {
      fail(`用例 ${spec.caseId} 录制自验失败`, selfCheck);
    }
    recordedTurns += selfCheck.verified;
    console.log(`  ✓ 录制 ${spec.caseId}: ${turns.length} 轮（${spec.coverage.join(' + ')}），自验通过`);
  }

  console.log(`snapshot replay corpus recorded: ${SNAPSHOT_CASES.length} 条会话 ${recordedTurns} 轮 → ${path.relative(repoRoot, options.corpusDir)}`);

  if (!options.keepTmp) {
    await chmod(memoryDir, 0o755).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}
