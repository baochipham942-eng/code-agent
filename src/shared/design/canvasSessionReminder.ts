/**
 * R1（设计 Surface 会话化）冷启动引导：设计画布会话激活时，由服务端按每轮注入系统上下文，
 * 明确告诉 agent 用 ProposeCanvasOps / RequestDesignAutonomy 操作画布，别用 shell / python /
 * 写文件等方式绕开画布。
 *
 * 关键：这段引导**不进用户消息 content**，只在服务端（web=systemPrompt，electron=turnSystemContext）
 * 按轮注入——agent 看得到、不持久化、不污染历史会话里的用户提示词。
 *
 * 工具名必须精确大写驼峰（与 protocol schema name 一致），否则 agent 照着 select 会 not found。
 */
export function formatDesignCanvasSessionReminder(): string {
  return [
    '<system-reminder kind="design-canvas-session">',
    '你正在一个「设计画布」协作会话中，右侧画布是与用户共同迭代的视觉产物面。',
    '要在画布上创建或修改任何视觉内容（生成图片、添加/排布节点、连线、标注、出多个变体等），必须调用 ProposeCanvasOps 工具提议画布操作，由用户在画布上审批后落地；需要一次性产出多个变体供用户挑选时用 RequestDesignAutonomy。',
    '要生成视频（文生视频 / 图生视频）用 ProposeVideoOps 工具——它会在对话里向用户确认成本，确认后出视频并落到画布视频节点。',
    '要做演示稿 / 幻灯片（PPT）用 ProposeSlidesOps 工具——大纲排版免费，配图付费时会在对话里确认成本，生成后在预览 tab 打开。',
    '要做网页 / 落地页 / 可交互 HTML 原型时，直接写一个自包含的 .html 文件到工作目录（这是网页产物的正确方式，不受下面图片/视频限制约束），用户可在预览 tab 打开查看。',
    '本会话已停用通用 image_generate / video_generate / image_annotate 工具——图片走 ProposeCanvasOps、视频走 ProposeVideoOps，别去搜这些通用工具。',
    '严禁用 shell / python / ffmpeg / 写文件等方式生成图片或视频、绕开画布——画布是本会话唯一的视觉产物面（此限制只针对图片/视频，不限制写 HTML 网页文件）。',
    '</system-reminder>',
  ].join('\n');
}

/**
 * web HTTP 路径专用：把设计画布会话引导拼到既有 systemPrompt 之后（不覆盖 web-mode 提示）。
 * designCanvasActive 为假时原样返回 base。
 */
export function composeDesignCanvasSystemPrompt(
  base: string | undefined,
  designCanvasActive: boolean | undefined,
): string | undefined {
  if (!designCanvasActive) {
    return base;
  }
  const reminder = formatDesignCanvasSessionReminder();
  return base ? `${base}\n\n${reminder}` : reminder;
}
