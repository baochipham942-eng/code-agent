import { cpSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

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
