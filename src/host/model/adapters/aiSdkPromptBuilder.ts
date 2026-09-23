import type {
  ModelMessage as AiModelMessage,
  SystemModelMessage as AiSystemModelMessage,
} from 'ai';

export interface AiSdkPromptShape {
  // v7 把顶层 `system` 改名为 `instructions`（`system` 仍在但已 deprecated）。
  // 数组形态受支持 ⇒ 挂在 system 消息上的 providerOptions.anthropic.cacheControl
  // 原样保留，不退化成拼接字符串。
  instructions?: AiSystemModelMessage[];
  messages: AiModelMessage[];
}

export function buildAiSdkPrompt(aiMessages: AiModelMessage[]): AiSdkPromptShape {
  const system: AiSystemModelMessage[] = [];
  const nonSystem: AiModelMessage[] = [];

  for (const message of aiMessages) {
    if (message.role === 'system') {
      system.push(message as AiSystemModelMessage);
    } else {
      nonSystem.push(message);
    }
  }

  return {
    ...(system.length > 0 ? { instructions: system } : {}),
    messages: nonSystem,
  };
}
