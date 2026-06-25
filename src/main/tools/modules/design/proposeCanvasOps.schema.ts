// Schema-only（ADR-026）：proposeCanvasOps —— agent 向用户**提议**一批设计画布操作，
// 阻塞等人审批；批准后由 renderer 应用（agent 不直接改画布）。
//
// IMPORTANT：inputSchema 同时被 LLM 读（决定怎么产 op）与 renderer 读（经 CANVAS_PROPOSAL_ASK
// 渲染 ghost 预览）。字段须与 shared/contract/canvasProposal 的 CanvasProposalOp 对齐。
// 一刀 op 集（Layer1，无付费）：moveNode / addConnector / addShape / renameNode；
// 三刀：discardNode 软删；二刀：generateImage 文生图（含付费，人审批后才出图）。
import type { ToolSchema } from '../../../protocol/tools';

export const proposeCanvasOpsSchema: ToolSchema = {
  name: 'ProposeCanvasOps',
  description: `Propose a batch of edits to the design canvas (arrange/connect/annotate existing items) and WAIT for the user to approve or reject. You do NOT edit the canvas directly — the user reviews a visual preview and applies it. Use this in the design workspace to lay out user flows, connect screens, or label steps.

Each op refers to existing nodes by their id (from the injected canvas snapshot). Supported ops:
- moveNode {nodeId,x,y}: reposition an existing node.
- addConnector {fromNodeId,toNodeId,label?}: draw an arrow between two existing nodes.
- addShape {shape}: add a freeform shape/label (rect/ellipse/sticky/text/line).
- renameNode {nodeId,label}: label a node.
- discardNode {nodeId}: soft-remove a node — it is hidden but RECOVERABLE by the user, never permanently deleted. Use sparingly, only for clearly-unwanted drafts.
- generateImage {prompt, model?, aspectRatio?}: propose generating a NEW image and adding it to the canvas. This is a PAID operation — the user sees the estimated cost and must approve before any image is generated; you never trigger payment yourself. Give a clear, self-contained prompt. The image is auto-placed by the canvas; do not specify coordinates. To connect or move the new image, propose those ops in a LATER turn (its id does not exist yet).
Only image generation is supported here (no video / no editing of existing images yet). For non-generate ops, only target nodes that exist in the current canvas snapshot.`,
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
              enum: ['moveNode', 'addConnector', 'addShape', 'renameNode', 'discardNode', 'generateImage'],
              description: 'Op type.',
            },
            nodeId: { type: 'string', description: 'Target node id (moveNode/renameNode/discardNode).' },
            x: { type: 'number', description: 'New x (moveNode).' },
            y: { type: 'number', description: 'New y (moveNode).' },
            fromNodeId: { type: 'string', description: 'Source node id (addConnector).' },
            toNodeId: { type: 'string', description: 'Target node id (addConnector).' },
            label: { type: 'string', description: 'Connector label (addConnector) or node label (renameNode).' },
            shape: {
              type: 'object',
              description: 'Shape geometry (addShape): {kind:rect|ellipse|sticky|text|line, ...coords, text?, color?}.',
            },
            prompt: { type: 'string', description: 'Image generation prompt (generateImage). Self-contained.' },
            model: { type: 'string', description: 'Optional configured visual model id (generateImage); falls back to default if unset/unavailable.' },
            aspectRatio: { type: 'string', description: 'Optional aspect ratio like "16:9"/"1:1"/"9:16" (generateImage).' },
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
