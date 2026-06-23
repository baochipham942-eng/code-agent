// Schema-only（ADR-026）：proposeCanvasOps —— agent 向用户**提议**一批设计画布操作，
// 阻塞等人审批；批准后由 renderer 应用（agent 不直接改画布）。
//
// IMPORTANT：inputSchema 同时被 LLM 读（决定怎么产 op）与 renderer 读（经 CANVAS_PROPOSAL_ASK
// 渲染 ghost 预览）。字段须与 shared/contract/canvasProposal 的 CanvasProposalOp 对齐。
// 第一刀 op 集（Layer1，无付费）：moveNode / addConnector / addShape / renameNode。
import type { ToolSchema } from '../../../protocol/tools';

export const proposeCanvasOpsSchema: ToolSchema = {
  name: 'ProposeCanvasOps',
  description: `Propose a batch of edits to the design canvas (arrange/connect/annotate existing items) and WAIT for the user to approve or reject. You do NOT edit the canvas directly — the user reviews a visual preview and applies it. Use this in the design workspace to lay out user flows, connect screens, or label steps.

Each op refers to existing nodes by their id (from the injected canvas snapshot). Supported ops (this version):
- moveNode {nodeId,x,y}: reposition an existing node.
- addConnector {fromNodeId,toNodeId,label?}: draw an arrow between two existing nodes.
- addShape {shape}: add a freeform shape/label (rect/ellipse/sticky/text/line).
- renameNode {nodeId,label}: label a node.
NOT supported here: creating images (paid generation) or deleting anything. Only propose ops whose target nodes exist in the current canvas.`,
  inputSchema: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        description: 'The batch of proposed canvas operations. Each item is one op keyed by "kind".',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['moveNode', 'addConnector', 'addShape', 'renameNode'],
              description: 'Op type.',
            },
            nodeId: { type: 'string', description: 'Target node id (moveNode/renameNode).' },
            x: { type: 'number', description: 'New x (moveNode).' },
            y: { type: 'number', description: 'New y (moveNode).' },
            fromNodeId: { type: 'string', description: 'Source node id (addConnector).' },
            toNodeId: { type: 'string', description: 'Target node id (addConnector).' },
            label: { type: 'string', description: 'Connector label (addConnector) or node label (renameNode).' },
            shape: {
              type: 'object',
              description: 'Shape geometry (addShape): {kind:rect|ellipse|sticky|text|line, ...coords, text?, color?}.',
            },
          },
          required: ['kind'],
        },
      },
      rationale: {
        type: 'string',
        description: 'One short sentence shown to the user explaining why you propose these changes.',
      },
    },
    required: ['ops'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
