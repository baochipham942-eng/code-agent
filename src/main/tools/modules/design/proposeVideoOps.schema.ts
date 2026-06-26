// Schema-only（2b — ProposeVideoOps）：agent 在设计会话里提议生成一段视频。
//
// 与 ProposeCanvasOps（图像/排布）分开：视频是付费高成本操作，**成本确认在会话区做**
// （非画布审批条），且**永不进 ADR-027 自主信封**（每次都要人确认）。确认后由 renderer
// 出视频并落画布视频节点。字段须与 shared/contract/canvasVideo 的 CanvasVideoRequest 对齐。
import type { ToolSchema } from '../../../protocol/tools';

export const proposeVideoOpsSchema: ToolSchema = {
  name: 'ProposeVideoOps',
  description: `Propose generating a short video in the design canvas. This is a PAID, higher-cost operation: the user sees the estimated cost IN THE CONVERSATION and must confirm before any video is generated — you never trigger payment yourself, and video is never auto-generated in bulk. On confirmation the video is produced and added to the design canvas as a video node.

Modes:
- t2v (text-to-video): give a clear, self-contained "prompt" describing the desired video.
- i2v (image-to-video): animate an existing image node — set mode="i2v" and "baseNodeId" to that node's id (from the injected canvas snapshot). A "prompt" can refine the motion.

Use this only in the design workspace. Do not specify coordinates — the canvas auto-places the result.`,
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['t2v', 'i2v'],
        description: 'text-to-video (t2v) or image-to-video (i2v, requires baseNodeId).',
      },
      prompt: {
        type: 'string',
        description: 'Video description (required for t2v; optional motion hint for i2v). Self-contained.',
      },
      baseNodeId: {
        type: 'string',
        description: 'Existing image node id to animate (i2v only).',
      },
      model: {
        type: 'string',
        description: 'Optional configured video model id; falls back to a valid default for the mode if unset/unavailable.',
      },
      durationSec: {
        type: 'number',
        description: 'Desired duration in seconds; clamped to the model\'s allowed range.',
      },
    },
    required: ['mode'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
