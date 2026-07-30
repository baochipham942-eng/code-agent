// ============================================================================
// 运行时模型身份注入（QA 2026-07-28 A1）
// 系统提示词里必须带当前会话真实模型，否则模型只能靠训练知识自报身份（实测
// 把 deepseek-v4-flash 说成 LongCat-2.0）。provider 只作消歧上下文，回答用户
// 时直接报模型名，不要带 provider/ 前缀（重复且难读）。从 messageBuild.ts 拆出，
// 控制单文件行数。
// ============================================================================

const RUNTIME_MODEL_IDENTITY_MARKER = '<!-- code-agent-runtime-model-identity:v1 -->';

export function injectRuntimeModelIdentity(
  systemPrompt: string,
  provider?: string,
  model?: string,
): string {
  const providerId = provider?.trim().replace(/[\r\n]+/g, ' ');
  const modelId = model?.trim().replace(/[\r\n]+/g, ' ');
  if (!providerId || !modelId || systemPrompt.includes(RUNTIME_MODEL_IDENTITY_MARKER)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${RUNTIME_MODEL_IDENTITY_MARKER}
<runtime_model_identity>
当前会话实际使用的模型是 ${modelId}（provider: ${providerId}）。如果用户询问模型身份，请直接回答模型名「${modelId}」，不要带 provider 前缀，也不要猜测或自报其他模型。
</runtime_model_identity>`;
}
