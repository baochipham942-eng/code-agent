// ============================================================================
// Bash Output Preview — 纯逻辑（无 React 依赖，便于单测）
// ============================================================================
// 折叠回车进度帧 + 长输出留头尾弃中间。从 index.tsx 抽出，渲染层只负责画。
// 入参 cleaned 已由调用方做过 stripAnsi + trim。
// ============================================================================

export const BASH_PREVIEW_LINES_PENDING = 5;
export const BASH_PREVIEW_LINES_COMPLETED = 20;

// 折叠回车进度帧：spinner / 进度条用 \r 在原地刷新同一行（"10%\r20%\r100%"），
// 按 \n 切后会变成一行里塞满历史帧。每行只保留最后一个 \r 之后的内容（最终帧）。
// 顺带处理 \b（退格）：常见于动画 spinner 逐字符回退，折叠成最终可见文本。
function foldProgressFrame(line: string): string {
  const cr = line.lastIndexOf('\r');
  let frame = cr >= 0 ? line.slice(cr + 1) : line;
  if (frame.includes('\b')) {
    const out: string[] = [];
    for (const ch of frame) {
      if (ch === '\b') out.pop();
      else out.push(ch);
    }
    frame = out.join('');
  }
  return frame;
}

export interface BashPreviewResult {
  /** 要逐行渲染的内容（含中段省略标记，若有） */
  displayLines: string[];
  /** 被省略的行数（0 表示没截断） */
  omittedCount: number;
}

/**
 * 计算 Bash 输出预览要显示的行。
 * - pending：尾部 N 行（流式手感）
 * - completed 且超长：头 20% + 尾 80% + 中段省略标记（最终结果/报错通常在尾部，
 *   头部留少量上下文）；旧实现是 slice(0,20) 硬截头，会把关键结尾全丢掉
 */
export function computeBashPreviewLines(
  cleaned: string,
  isPending: boolean,
): BashPreviewResult {
  const allLines = cleaned.split('\n').map(foldProgressFrame);

  if (isPending) {
    return { displayLines: allLines.slice(-BASH_PREVIEW_LINES_PENDING), omittedCount: 0 };
  }

  if (allLines.length <= BASH_PREVIEW_LINES_COMPLETED) {
    return { displayLines: allLines, omittedCount: 0 };
  }

  const headCount = Math.max(1, Math.floor(BASH_PREVIEW_LINES_COMPLETED * 0.2)); // 4
  const tailCount = BASH_PREVIEW_LINES_COMPLETED - headCount; // 16
  const head = allLines.slice(0, headCount);
  const tail = allLines.slice(-tailCount);
  const omittedCount = allLines.length - headCount - tailCount;

  return {
    displayLines: [...head, `…省略 ${omittedCount} 行…`, ...tail],
    omittedCount,
  };
}
