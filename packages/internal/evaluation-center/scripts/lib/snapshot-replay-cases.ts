// N-SNAPSHOT-REGRESSION：snapshot-replay 的用例清单与录制环境规划。
// 本模块只许依赖 node 内置——CLI 在任何 host 模块加载之前就要靠它把
// CODE_AGENT_DATA_DIR 等 env 落定（host 侧 databaseService/appPaths 在 import
// 期就会按 env 缓存路径，晚设 = 录制材料落到真实 ~/.code-agent，07 首踩）。

import path from 'path';
import { tmpdir } from 'os';

export interface SnapshotCaseSpec {
  caseId: string;
  title: string;
  coverage: string[];
  prompts: string[];
  expectedTurns: number;
  expectedTools: string[];
}

export const SNAPSHOT_CASES: SnapshotCaseSpec[] = [
  {
    caseId: 'single-turn-qa',
    title: '单轮问答：无工具调用的一次性文本应答',
    coverage: ['single-turn', 'no-tool'],
    prompts: ['E2E_SNAPSHOT_REPLAY_QA：用一句话说明什么是快照回归。'],
    expectedTurns: 1,
    expectedTools: [],
  },
  {
    caseId: 'read-fixture',
    title: 'Read 工具调用 + 工具结果回填后的收尾应答',
    coverage: ['Read', 'tool-result-backfill'],
    prompts: ['请读取工作区里的录制夹具并复述其中的 marker。'],
    expectedTurns: 2,
    expectedTools: ['Read'],
  },
  {
    caseId: 'write-file',
    title: 'Write 落盘 + 写结果回填后的收尾应答',
    coverage: ['Write', 'tool-result-backfill'],
    prompts: ['E2E_SNAPSHOT_REPLAY_WRITE：把快照便签写进工作区。'],
    expectedTurns: 2,
    expectedTools: ['Write'],
  },
  {
    caseId: 'bash-echo',
    title: 'Bash 确定性 echo + 命令输出回填后的收尾应答',
    coverage: ['Bash', 'tool-result-backfill'],
    prompts: ['E2E_SNAPSHOT_REPLAY_BASH：跑一下确定性 echo 并告诉我输出。'],
    expectedTurns: 2,
    expectedTools: ['Bash'],
  },
  {
    caseId: 'multi-turn-followup',
    title: '多轮会话：第一条 Read，第二条纯文本追问（账本跨轮增长）',
    coverage: ['multi-turn', 'Read', 'tool-result-backfill'],
    prompts: [
      '请读取工作区里的录制夹具。',
      '用一句话总结你刚才读到的 marker。',
    ],
    expectedTurns: 3,
    expectedTools: ['Read'],
  },
  {
    caseId: 'read-then-write',
    title: '混合工具路径：同一会话内 Read 后接 Write',
    coverage: ['Read', 'Write', 'tool-result-backfill'],
    prompts: ['E2E_SNAPSHOT_REPLAY_READ_WRITE：先读夹具再把要点写进便签。'],
    expectedTurns: 3,
    expectedTools: ['Read', 'Write'],
  },
];

export const SNAPSHOT_READ_FIXTURE_NAME = 'snapshot-read-target.txt';
export const SNAPSHOT_WRITE_TARGET_NAME = 'snapshot-write-note.txt';
export const SNAPSHOT_READ_FIXTURE_MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

export interface SnapshotRecordLayout {
  dataDir: string;
  workspaceDir: string;
  traceDir: string;
  readFixturePath: string;
  writeTargetPath: string;
}

/** 固定目录名（非 mkdtemp 随机后缀）：工作区路径会冻进快照字节，同机重录必须同字节。 */
export function planSnapshotRecordDataDir(): string {
  return path.join(tmpdir(), 'agent-neo-snapshot-replay');
}

/**
 * 每用例一个独立工作区：Write 的 read-before-overwrite 门会把上一用例留下的
 * 同名便签当成「既有文件」拒写（2026-09-07 首踩），用例间必须零文件共享。
 */
export function planSnapshotRecordLayout(dataDir: string, caseId: string): SnapshotRecordLayout {
  const workspaceDir = path.join(dataDir, 'workspace', caseId);
  return {
    dataDir,
    workspaceDir,
    traceDir: path.join(dataDir, 'traces'),
    readFixturePath: path.join(workspaceDir, SNAPSHOT_READ_FIXTURE_NAME),
    writeTargetPath: path.join(workspaceDir, SNAPSHOT_WRITE_TARGET_NAME),
  };
}

/** 录制需要的假模型 env（回放重推导响应时用同一份，路径字节才咬得上）。 */
export function snapshotFakeModelEnv(layout: SnapshotRecordLayout): Record<string, string> {
  return {
    CODE_AGENT_E2E: '1',
    CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1',
    CODE_AGENT_E2E_AGENT_MODEL_READ_FILE: layout.readFixturePath,
    CODE_AGENT_E2E_AGENT_MODEL_WRITE_FILE: layout.writeTargetPath,
  };
}
