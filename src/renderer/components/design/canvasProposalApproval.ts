import type { CanvasProposalOp } from '@shared/contract';
import { hasUserTouch } from './canvasActor';
import type { CanvasNode } from './designCanvasTypes';

export type CanvasApprovalReason = 'user-touched' | 'standard';

export interface CanvasProposalSplit {
  directOps: CanvasProposalOp[];
  approvalOps: CanvasProposalOp[];
  approvalReason: CanvasApprovalReason;
}

function canAgentEditDirectly(node: CanvasNode | undefined): boolean {
  return node?.createdBy === 'agent' && !hasUserTouch(node);
}

/**
 * 分级免审批策略。新增图解实体直接落地；agent 自建且用户未碰过的节点可直接排布/改内容；
 * 删除、付费生成、用户创建/碰过的节点继续走审批。stale target 直接交给应用引擎跳过，不打扰用户。
 */
export function splitCanvasProposalOps(
  ops: CanvasProposalOp[],
  nodes: readonly CanvasNode[],
): CanvasProposalSplit {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const directOps: CanvasProposalOp[] = [];
  const approvalOps: CanvasProposalOp[] = [];
  let touchesUserEdited = false;

  for (const op of ops) {
    switch (op.kind) {
      case 'addConnector':
      case 'addShape':
        directOps.push(op);
        break;
      case 'moveNode':
      case 'renameNode': {
        const target = nodesById.get(op.nodeId);
        if (!target || canAgentEditDirectly(target)) {
          directOps.push(op);
        } else {
          approvalOps.push(op);
          if (hasUserTouch(target) || target.createdBy === 'user') touchesUserEdited = true;
        }
        break;
      }
      case 'discardNode':
      case 'generateImage':
        approvalOps.push(op);
        break;
    }
  }

  return {
    directOps,
    approvalOps,
    approvalReason: touchesUserEdited ? 'user-touched' : 'standard',
  };
}

/**
 * 陈旧检出（审批期间节点被用户拖走）：moveNode 的目标节点在提议到达之后被用户碰过
 * （userTouchedAt > receivedAt）⇒ 该 op 的绝对坐标已过期（agent 按提议时的快照算的）。
 * 判据是「提议之后」，不是「碰过」——提议到达前就有 userTouchedAt 的节点不算陈旧。
 * 逐 op 判定：同批其它未被拖动的 op 不受影响。
 */
export function staleMoveNodeIds(
  ops: readonly CanvasProposalOp[],
  nodes: readonly CanvasNode[],
  receivedAt: number,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stale = new Set<string>();
  for (const op of ops) {
    if (op.kind !== 'moveNode') continue;
    const target = byId.get(op.nodeId);
    if (target?.userTouchedAt !== undefined && target.userTouchedAt > receivedAt) {
      stale.add(op.nodeId);
    }
  }
  return stale;
}
