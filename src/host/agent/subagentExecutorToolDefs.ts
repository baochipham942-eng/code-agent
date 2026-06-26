// ============================================================================
// Subagent Executor Tool Definitions Helper
// ============================================================================
// 从 SubagentExecutor 抽出的纯工具定义过滤逻辑（不依赖实例状态）。

import type { ToolDefinition } from '../../shared/contract';
import type { ToolResolver } from '../tools/dispatch/toolResolver';
import { resolveToolAlias } from '../services/toolSearch/deferredTools';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SubagentExecutor');

export function filterSubagentToolDefs(
  allowedToolNames: string[],
  resolver: ToolResolver,
): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  const missing: string[] = [];
  for (const name of allowedToolNames) {
    // agent 定义里仍用 legacy snake_case 工具名（glob/grep/read_file/list_directory/
    // web_search 等），而 protocol registry 用 PascalCase 规范名。先过 resolveToolAlias
    // 归一，否则子代理的核心工具会被整组 strip 掉（"not found in registry"），导致 spawn
    // 出来的子代理无工具可用、干不成活。这是多 agent 委派"跑不通"的根因之一。
    const canonical = resolveToolAlias(name);
    const def = resolver.getDefinition(canonical) ?? resolver.getDefinition(name);
    if (def) {
      defs.push(def);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    logger.warn(`filterToolDefs: ${missing.length} tools not found in registry: ${missing.join(', ')}`);
  }
  return defs;
}
