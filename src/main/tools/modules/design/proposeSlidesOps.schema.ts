// Schema-only（2b — ProposeSlidesOps）：agent 在设计会话里生成一份演示稿（slides deck）。
//
// 文档型产物：生成 .pptx 后落到工作台预览 tab（非 konva 画布）。大纲排版免费；可选 illustrate
// 为内容页配图（付费）——此时在会话区确认成本后才出图。字段对齐 GenerateSlidesDeckPayload。
import type { ToolSchema } from '../../../protocol/tools';

export const proposeSlidesOpsSchema: ToolSchema = {
  name: 'ProposeSlidesOps',
  description: `Generate a slide deck (演示稿/PPTX) in the design workspace from a topic. The deck is produced and opened in a preview tab. Outline + layout are FREE. Optionally set illustrate=true to also generate one concept image per content slide — that is a PAID operation, and the user must confirm the estimated cost IN THE CONVERSATION before any image is generated.

Provide a clear "topic" describing what the deck is about. Use this for presentations/pitch decks/演示稿 — not for single images (use ProposeCanvasOps) or videos (use ProposeVideoOps).`,
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'What the deck is about (its subject / requirement). Required.',
      },
      slidesCount: {
        type: 'number',
        description: 'Desired number of slides (optional; defaults to a sensible value).',
      },
      theme: {
        type: 'string',
        description: 'Optional visual theme hint for the deck.',
      },
      illustrate: {
        type: 'boolean',
        description: 'If true, generate one concept image per content slide (PAID — user confirms cost in conversation first). Default false.',
      },
      imageModel: {
        type: 'string',
        description: 'Configured image model id for illustrations (illustrate only); falls back to default if unset/unavailable.',
      },
      maxImages: {
        type: 'number',
        description: 'Max number of slides to illustrate (illustrate only; default 4).',
      },
    },
    required: ['topic'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
