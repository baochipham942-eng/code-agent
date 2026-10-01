import { describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import type { TurnArtifactOwnershipItem } from '../../../src/shared/contract/turnTimeline';
import type { TurnDiffEventData, TurnDiffFileChange } from '../../../src/shared/contract/turnDiff';
import { buildArtifactOwnershipItems } from '../../../src/renderer/utils/artifactOwnership';
import { buildTurnFileChanges } from '../../../src/renderer/utils/turnDiffSummary';

const analyzeCjs: TurnDiffFileChange = {
  filePath: 'analyze.cjs',
  oldText: '',
  newText: 'module.exports = {}\n',
  added: 1,
  removed: 0,
  isNewFile: true,
  editCount: 1,
};

function writeNode(
  id: string,
  outputPath: string | undefined,
  metadata?: Record<string, unknown>,
): TraceTurn['nodes'][number] {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp: 1,
    toolCall: {
      id,
      name: 'Write',
      args: {},
      result: 'ok',
      success: true,
      ...(outputPath ? { outputPath } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

function turn(turnDiff: TurnDiffEventData | undefined, nodes: TraceTurn['nodes']): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 1,
    endTime: 2,
    ...(turnDiff ? { turnDiff } : {}),
    nodes,
  };
}

const analyzeJsCard: TurnArtifactOwnershipItem = {
  kind: 'file',
  role: 'deliverable',
  label: 'analyze.js',
  ownerKind: 'tool',
  ownerLabel: 'Write',
  path: 'analyze.js',
  sourceNodeId: 'tool-write',
};

describe('buildArtifactOwnershipItems absentPaths', () => {
  it('丢掉已不在磁盘上的 analyze.js，变更清单仍含 analyze.cjs（outputPath、metadata、ToolArtifact）', () => {
    const sample = turn({
      turnId: 'turn-1',
      files: [analyzeCjs],
      absentPaths: ['analyze.js', 'meta-gone.md', 'tool-gone.txt'],
    }, [
      writeNode('tool-write', 'analyze.js'),
      writeNode('tool-meta', undefined, { filePath: '/meta-gone.md' }),
      writeNode('tool-art', undefined, {
        artifact: {
          artifactId: 'art-gone',
          kind: 'document',
          sourceTool: 'ArtifactWriter',
          name: 'tool-gone.txt',
          path: '/tool-gone.txt',
        },
      }),
      writeNode('tool-keep', 'keep.txt'),
    ]);

    expect(buildArtifactOwnershipItems(sample)).toEqual([{
      kind: 'file',
      role: 'deliverable',
      label: 'keep.txt',
      ownerKind: 'tool',
      ownerLabel: 'Write',
      path: 'keep.txt',
      sourceNodeId: 'tool-keep',
    }]);
    expect(buildTurnFileChanges(sample).map((file) => file.filePath)).toEqual(['analyze.cjs']);
    expect(buildArtifactOwnershipItems(sample).some((item) => item.path?.endsWith('analyze.js'))).toBe(false);
  });

  it('无 absentPaths 字段的旧会话，产物卡与改前逐项相同', () => {
    const sample = turn({
      turnId: 'turn-legacy',
      files: [analyzeCjs],
    }, [writeNode('tool-write', 'analyze.js')]);

    expect(buildArtifactOwnershipItems(sample)).toEqual([analyzeJsCard]);
  });

  it('turnDiff 非权威时产物卡与改前逐项相同', () => {
    const sample = turn({
      turnId: 'turn-notice',
      files: [],
      filesAuthoritative: false,
      missingFiles: ['analyze.js'],
    }, [writeNode('tool-write', 'analyze.js')]);

    expect(buildArtifactOwnershipItems(sample)).toEqual([analyzeJsCard]);
  });

  it('路径不在 absentPaths 时产物卡与改前逐项相同', () => {
    const sample = turn({
      turnId: 'turn-other',
      files: [analyzeCjs],
      absentPaths: ['other.js'],
    }, [writeNode('tool-write', 'analyze.js')]);

    expect(buildArtifactOwnershipItems(sample)).toEqual([analyzeJsCard]);
  });
});
