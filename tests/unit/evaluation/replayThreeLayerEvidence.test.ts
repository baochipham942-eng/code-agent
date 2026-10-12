import { cpSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

// 持久层重放走真 Write 工具（writeModule → atomicWriteFile 产品路径，不许 mock）。
// 只 mock 两条纯环境件：infra logger（别把单测日志写进真实数据目录）与 LSP
// 诊断（单测进程没有 language server）。与 tests/unit/tools/modules/file/write.test.ts
// 同一套桩，被测的写入链本身保持真跑。
vi.mock('@host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('@host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import {
  assertReplayPersistedState,
  assertReplayProtocolLayer,
  assertReplayRenderLayer,
  writeReplayThreeLayerSidecars,
} from '@internal-evaluation/host/evaluation/replayThreeLayerEvidence';

const caseDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/internal/evaluation-center/snapshots/request-replay/write-file',
);
const corpusDir = path.dirname(caseDir);

describe('write-file 三层 hermetic 回放', () => {
  it('协议层：发往 provider 的请求序列与快照逐字节一致', () => {
    assertReplayProtocolLayer(caseDir);
  });

  it('渲染层：关键 UI 投影与 write-file.render.json 一致', () => {
    assertReplayRenderLayer(caseDir);
  });

  it('持久层：会话、产物哈希与审批记录与 write-file.state.json 一致', async () => {
    await assertReplayPersistedState(caseDir);
  });

  it('持久层产物字节是真 Write 工具写出来的，不是自写自哈希', async () => {
    // 与上一条 it 的差别在断言对象：这里直接拆旁路 JSON，要求产物条目声明
    // 「经 Write 工具重放」且落盘哈希等于账本请求正文哈希。自写自哈希的旧
    // 形态（没有 tool/requestSha256 字段）在这里红。
    const state = JSON.parse(readFileSync(path.join(corpusDir, 'write-file.state.json'), 'utf8')) as {
      artifacts: { tool: string; sha256: string; requestSha256: string }[];
    };
    expect(state.artifacts.length).toBeGreaterThan(0);
    for (const artifact of state.artifacts) {
      expect(artifact.tool).toBe('Write');
      expect(artifact.requestSha256).toBe(artifact.sha256);
    }
  });

  it('录制器写出的渲染层和持久层旁路与已提交基线一致', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'replay-three-layer-record-'));
    try {
      cpSync(caseDir, path.join(tempRoot, 'write-file'), { recursive: true });
      await writeReplayThreeLayerSidecars(path.join(tempRoot, 'write-file'));
      expect(readFileSync(path.join(tempRoot, 'write-file.render.json'), 'utf8')).toBe(
        readFileSync(path.join(corpusDir, 'write-file.render.json'), 'utf8'),
      );
      expect(readFileSync(path.join(tempRoot, 'write-file.state.json'), 'utf8')).toBe(
        readFileSync(path.join(corpusDir, 'write-file.state.json'), 'utf8'),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
