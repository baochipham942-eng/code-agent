// Schema-only（ADR-027）：RequestDesignAutonomy —— agent 请求一个「有界自主」预算信封，
// 阻塞等用户一次性审批。批准后 agent 可在信封内连续提议 generateImage 而无需逐张审批，
// 直到信封（变体数/¥ 双上限，先到先停）耗尽。付费前置审批没破——预算被预先批准。
import type { ToolSchema } from '../../../protocol/tools';

export const requestDesignAutonomySchema: ToolSchema = {
  name: 'RequestDesignAutonomy',
  description: `Request a BOUNDED-AUTONOMY budget envelope so you can iterate on the design canvas WITHOUT asking the user to approve every single image. The user approves a goal + budget ONCE; you then generate several DIVERGENT variants on your own and the user picks the best one at the end.

Use this when the user wants you to "explore a few directions" / "make some options" for an image (e.g. a hero image, an icon set, a poster). Do NOT use it for a single one-off image (just use ProposeCanvasOps for that), and only AFTER the design direction/brief is clear.

How it works once granted:
- You propose generateImage ops via ProposeCanvasOps. Within the envelope they auto-apply (no per-image approval) until the budget is spent.
- The autonomy value is DIVERSITY, not self-correction: produce variants that explore genuinely different directions. Do NOT try to "judge and fix" your own output — the user's pick is the only quality signal.
- After each image you are told the remaining budget. When the envelope is exhausted, STOP and ask the user to pick.
- Destructive ops (discard/delete) and video are NEVER autonomous — they still need step-by-step approval.

This is a PRE-AUTHORIZATION of spend, not free money: the user sees and approves the budget cap, and you can never exceed it.`,
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'One short sentence: what you want to autonomously explore (e.g. "explore 3 hero image directions for the landing page").',
      },
      maxVariants: {
        type: 'number',
        description: 'How many variants you propose to generate (the user may adjust). Capped by the system; omit to use the default.',
      },
      maxCny: {
        type: 'number',
        description: 'Optional proposed spend cap in CNY. Omit to let the system derive a safe default from the variant count.',
      },
      rationale: {
        type: 'string',
        description: 'One short sentence shown to the user explaining why autonomous exploration helps here.',
      },
    },
    required: ['goal'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
