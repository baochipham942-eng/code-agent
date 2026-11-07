import { describe, expect, it } from 'vitest';
import { buildTurnArtifactDeliverableCards } from '../../../src/renderer/utils/deliverables';

// owner 决策（N-DELIVERABLE-DEDUP-VERIFY-FU2，11-06）：每轮一张卡、不做跨轮合并。
// 轮内去重（deliverables.ts 的 dedupKeyForCard / lastIndexByKey）只折叠同一次
// buildTurnArtifactDeliverableCards 调用内的重复项；两次独立调用（两个轮次）互不影响，
// 各自返回自己的卡。这里在 renderer 层把该决策钉死，不需要真实 web build。
describe('buildTurnArtifactDeliverableCards 跨轮不合并', () => {
  it('连续两轮各写同一个文件：每轮调用各返回恰好 1 张卡', () => {
    const turnOne = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'report.html',
        ownerKind: 'tool',
        ownerLabel: 'coder · Write',
        path: '/repo/out/report.html',
        sourceNodeId: 'turn-one-node',
      },
    ]);
    const turnTwo = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'report.html',
        ownerKind: 'tool',
        ownerLabel: 'coder · Edit',
        path: '/repo/out/report.html',
        sourceNodeId: 'turn-two-node',
      },
    ]);

    expect(turnOne).toHaveLength(1);
    expect(turnTwo).toHaveLength(1);
  });

  it('两轮的卡是两个不同对象，溯源各自指向本轮的 trace 节点', () => {
    const [turnOneCard] = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'report.html',
        ownerKind: 'tool',
        ownerLabel: 'coder · Write',
        path: '/repo/out/report.html',
        sourceNodeId: 'turn-one-node',
      },
    ]);
    const [turnTwoCard] = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'report.html',
        ownerKind: 'tool',
        ownerLabel: 'coder · Edit',
        path: '/repo/out/report.html',
        sourceNodeId: 'turn-two-node',
      },
    ]);

    expect(turnOneCard).not.toBe(turnTwoCard);
    expect(turnOneCard.contextPack.sourceOfTruth).toEqual(['/repo/out/report.html', 'trace-node:turn-one-node']);
    expect(turnTwoCard.contextPack.sourceOfTruth).toEqual(['/repo/out/report.html', 'trace-node:turn-two-node']);
    expect(turnOneCard.id).not.toBe(turnTwoCard.id);
  });
});
