import type { TraceNode } from '@shared/contract/trace';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import type { DisplayNode } from '../../../utils/toolStepGrouping';

interface ReceiptStepIntegration {
  matchedReceiptItems: TurnArtifactOwnershipItem[];
  residualArtifactNode: TraceNode | undefined;
}

export function integrateToolReceipts(
  artifactNode: TraceNode | undefined,
  displayNodes: DisplayNode[],
): ReceiptStepIntegration {
  const groupedToolNodeIds = new Set(displayNodes.flatMap((item) => (
    item.kind === 'tool_group' ? item.tools.map((node) => node.id) : []
  )));
  const items = artifactNode?.turnTimeline?.artifactOwnership || [];
  const matchedReceiptItems = items.filter((item) => (
    item.role === 'receipt'
    && Boolean(item.sourceNodeId)
    && groupedToolNodeIds.has(item.sourceNodeId as string)
  ));
  const matchedSourceNodeIds = new Set(matchedReceiptItems.map((item) => item.sourceNodeId as string));

  if (!artifactNode?.turnTimeline || matchedReceiptItems.length === 0) {
    return { matchedReceiptItems, residualArtifactNode: artifactNode };
  }
  return {
    matchedReceiptItems,
    residualArtifactNode: {
      ...artifactNode,
      turnTimeline: {
        ...artifactNode.turnTimeline,
        artifactOwnership: items.filter((item) => (
          item.role !== 'receipt'
          || !item.sourceNodeId
          || !matchedSourceNodeIds.has(item.sourceNodeId)
        )),
      },
    },
  };
}
