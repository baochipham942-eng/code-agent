// ============================================================================
// PermissionTranslate IPC Handlers — 一句话权限规则翻译域（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// 只读域：prompt 进 → {status, draft, rule, restatement, reasonText} 出。
// 本域绝不写设置；保存仍是 renderer 在用户点确认后走 domain:settings set。
// 非 admin 门控（deny/ask/allow 对所有登录用户开放，同 settings 域规则三列表口径）。
// ============================================================================

import { ipcHost } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { PermissionTranslateSchemas, type PermissionTranslateDomainRequest } from '../../shared/ipc/schemas/permissionTranslate';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { NL_RULE_TEXT } from '../../shared/permissionRuleTranslate';
import {
  PermissionTranslateParseError,
  translatePermissionSentence,
} from '../permissions/permissionRuleTranslator';
import { getKnownToolNames } from '../tools/knownToolNames';
import { getMCPClient } from '../mcp/mcpClient';
import { getConfigService } from '../services/core/configService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PermissionTranslateIPC');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 真实工具名目录：已知工具全集 + 已连接 MCP 服务器的工具全名。 */
function buildToolCatalog(): string[] {
  const names = new Set<string>(getKnownToolNames());
  try {
    for (const tool of getMCPClient().getTools()) {
      names.add(`mcp__${tool.serverName}__${tool.name}`);
    }
  } catch (error) {
    // 目录兜底：MCP 枚举失败不拦翻译（具名 MCP 工具仍可按形态通过校验）
    logger.warn('MCP tool enumeration failed during translate', { error });
  }
  return [...names];
}

function currentExistingRules(): { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] } {
  const permissions = getConfigService().getSettings().permissions;
  return {
    ...(permissions.deny ? { deny: permissions.deny } : {}),
    ...(permissions.ask ? { ask: permissions.ask } : {}),
    ...(permissions.allow ? { allow: permissions.allow } : {}),
  };
}

const permissionTranslateHandlers: RawDomainRouteHandlers<PermissionTranslateDomainRequest, void> = {
  translate: async (_ctx, payload) => {
    const sentence = isRecord(payload) && typeof payload.sentence === 'string' ? payload.sentence : '';
    if (!sentence.trim()) {
      return { success: false, error: { code: 'INVALID_INPUT', message: '请先输入一句规则描述' } } satisfies IPCResponse;
    }
    try {
      const result = await translatePermissionSentence(sentence, {
        toolCatalog: buildToolCatalog(),
        existingRules: currentExistingRules(),
      });
      return { success: true, data: result } satisfies IPCResponse;
    } catch (error) {
      if (error instanceof PermissionTranslateParseError) {
        return { success: false, error: { code: 'TRANSLATE_PARSE_ERROR', message: NL_RULE_TEXT.parseError } } satisfies IPCResponse;
      }
      logger.error('Permission translate failed:', error);
      return { success: false, error: { code: 'MODEL_UNAVAILABLE', message: NL_RULE_TEXT.modelUnavailable } } satisfies IPCResponse;
    }
  },
};

const permissionTranslateRoutes = defineDomainRoutes<PermissionTranslateDomainRequest, void>(
  PermissionTranslateSchemas.REQUEST,
  permissionTranslateHandlers,
  {
    rawResponse: true,
    mapError: (error) => {
      logger.error('PermissionTranslate IPC error:', error);
      return { code: 'TRANSLATE_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
    },
  },
);

export function registerPermissionTranslateHandlers(): void {
  installDomainRoutes(ipcHost, permissionTranslateRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（registerCronHandlers.routes 先例）
registerPermissionTranslateHandlers.routes = permissionTranslateRoutes;
