const PREVIEW_MAX_CHARS = 28;

/** 「等你批准：<预览>」文案；没有预览返回 null，由调用方回落到原文案。 */
export function awaitingApprovalLabel(template: string, preview?: string): string | null {
  const text = preview?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const clipped = text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text;
  return template.replace('{preview}', clipped);
}
