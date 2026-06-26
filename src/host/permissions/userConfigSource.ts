// ============================================================================
// User Config Source - GuardSource backed by user-defined permission rules
// ============================================================================
//
// 把 AppSettings.permissions.{deny, ask, allow} 暴露成 GuardFabric 的一个独立
// source。底层共用 PolicyEngine（user 规则通过 loadUserRules 写入 PolicyEngine），
// 这里只在命中的规则是 `user-` 前缀时才返回 verdict，避免和 PolicyEngineSource
// 抢内置规则的归属（PolicyEngineSource 处理 priority < 500 的内置规则）。
//
// 设计依据：plan §4.5 / R3。trace 上需要清晰区分 "用户 deny" vs "内置规则 deny"，
// 否则双源同时命中时 reason 字段会混乱。
// ============================================================================

import type { GuardSource, GuardRequest, GuardSourceResult, GuardVerdict } from './guardFabric';
import { getPolicyEngine } from './policyEngine';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('UserConfigSource');

/** 通过 PolicyEngine.loadUserRules 注入的规则 id 都以这个前缀开头 */
const USER_RULE_ID_PREFIX = 'user-';

export class UserConfigSource implements GuardSource {
  name = 'user-config';

  evaluate(request: GuardRequest): GuardSourceResult | null {
    try {
      const result = getPolicyEngine().evaluate({
        tool: request.tool,
        level: 'execute',
        description: `tool: ${request.tool}`,
        command: request.args?.command as string,
        filePath: (request.args?.filePath as string) || (request.args?.file_path as string),
        sessionId: request.sessionId,
      });

      // 仅当命中的是用户级规则才返回 verdict
      const ruleId = result.matchedRule?.id ?? '';
      if (!ruleId.startsWith(USER_RULE_ID_PREFIX)) {
        return null;
      }

      const verdict: GuardVerdict =
        result.action === 'allow' ? 'allow'
          : result.action === 'deny' ? 'deny'
          : 'ask';

      return {
        verdict,
        confidence: 0.9,
        source: 'user-config',
        reason: `user-config: ${result.matchedRule?.name ?? ruleId}${result.reason ? ` — ${result.reason}` : ''}`,
      };
    } catch (error) {
      logger.debug('UserConfigSource evaluation failed', { error: error instanceof Error ? error.message : error });
      return null;
    }
  }
}
