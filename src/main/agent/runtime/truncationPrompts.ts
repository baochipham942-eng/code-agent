// ============================================================================
// Truncation Prompts - 截断/续写提示文本生成
// 从 messageProcessor 抽出的纯函数（无状态、无副作用），集中管理截断恢复的
// 提示文本，便于统一维护与复用。
// ============================================================================

/**
 * 工具调用因输出长度被截断时，注入的多步重写指引。
 */
export function generateTruncationWarning(): string {
  return (
    `<truncation-detected>\n` +
    `⚠️ CRITICAL: Your previous tool call was TRUNCATED due to output length limits!\n` +
    `The file content is INCOMPLETE and will not work correctly.\n\n` +
    `You MUST use a MULTI-STEP approach for large files:\n` +
    `1. First, create a SKELETON file with just the structure (HTML head, empty body, empty script tag)\n` +
    `2. Then use edit_file to ADD sections one at a time:\n` +
    `   - Step 1: Add CSS styles\n` +
    `   - Step 2: Add HTML body content\n` +
    `   - Step 3: Add JavaScript variables and constants\n` +
    `   - Step 4: Add JavaScript functions (one or two at a time)\n` +
    `   - Step 5: Add event listeners and initialization\n\n` +
    `DO NOT try to write the entire file in one write_file call!\n` +
    `</truncation-detected>`
  );
}

/**
 * write_file 检测到文件不完整（缺少闭合括号/标签）时，注入的续写指引。
 */
export function generateAutoContinuationPrompt(): string {
  return (
    `<auto-continuation-required>\n` +
    `CRITICAL: The file you just wrote appears to be INCOMPLETE (truncated).\n` +
    `The write_file tool detected missing closing brackets/tags.\n\n` +
    `You MUST immediately:\n` +
    `1. Use edit_file to APPEND the remaining code to complete the file\n` +
    `2. Start from where the code was cut off\n` +
    `3. Ensure all functions, classes, and HTML tags are properly closed\n\n` +
    `DO NOT start over or rewrite the entire file - just APPEND the missing parts!\n` +
    `</auto-continuation-required>`
  );
}
