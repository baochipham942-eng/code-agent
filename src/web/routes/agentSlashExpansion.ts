import { getPromptCommandService } from '../../host/services/commands/promptCommandService';
import { createLogger } from '../../host/services/infra/logger';

const logger = createLogger('AgentSlashExpansion');

/**
 * 桌面主链 /api/run 的 "/name args" 模型面展开（appService.sendMessage 的对应物）。
 * 只改模型面文本；展示 / 持久化 / 标题仍用调用方的字面量。
 * 非命令、未注册、展开失败一律返回原文，绝不阻塞运行。
 * 注：frontmatter agent 覆盖在本路由没有等价挂点，此处不处理。
 */
export async function expandSlashPromptForModel(
  visiblePrompt: string,
  workingDirectory?: string,
): Promise<string> {
  if (!visiblePrompt.startsWith('/')) return visiblePrompt;
  try {
    const resolution = await getPromptCommandService().resolveInvocation(visiblePrompt, workingDirectory);
    if (!resolution) return visiblePrompt;
    logger.info('Expanded prompt command', { name: resolution.name, source: resolution.source });
    return resolution.prompt;
  } catch (err) {
    logger.warn('Prompt command expansion failed; sending literal text', { error: String(err) });
    return visiblePrompt;
  }
}
