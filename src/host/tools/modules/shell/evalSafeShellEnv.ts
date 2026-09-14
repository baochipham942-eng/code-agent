// ============================================================================
// Eval-Safe Shell Env（bash 子进程 env 组装：sanitize → strip → secureref 哨兵）
//
// 从 bash.ts 拆出（max-lines 门）：三条执行路径（前台/后台/PTY）共用的子进程
// env 组装。职责链：
//   1. createSanitizedEnv：值消毒 + extra 覆盖（如 PATH 诊断）。
//   2. eval 模式整名删除（CODE_AGENT_EVAL_REAL_ROOT 在场时）。
//   3. filterSecretEnvVars 按名 strip（A8；[env_filter] 逃逸口：
//      strip_secret_vars=false 总开关 / allowed_secret_vars 按名放行明文）。
//   4. ADR-066 刀 2：被剥名字注入 secureref:env.<NAME> 占位，真值留内存快照；
//      仅放网跳（refill.allowNetwork）按需回填；解不开且命令文本引用 →
//      fail-closed 不 exec，稳定 code，错误串只带 env.NAME。
// ============================================================================

import type { ToolContext } from '../../../protocol/tools';
import { createSanitizedEnv } from '../../../utils/sanitizeEnv';
import { filterSecretEnvVars } from '../../../utils/envSecretFilter';
import { injectEnvSecretRefs, backfillEnvSecretRefs } from '../../../utils/envSecretRefs';
import { getEnvFilterPolicy } from '../../../security/policyLoader';

export interface EvalSafeShellEnvRefill {
  /** 这一跳是否放网（resolveSandboxNetworkPolicy）；放网才把引用解回真值。 */
  allowNetwork: boolean;
  /** 本跳命令文本，fail-closed 判定用（$FOO 出现且引用解不开 → 不 exec）。 */
  command: string;
}

export type EvalSafeShellEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string; code: string };

export function createEvalSafeShellEnv(
  extra: Record<string, string | undefined> | undefined,
  projectDir: string,
  logger?: ToolContext['logger'],
  refill?: EvalSafeShellEnvRefill,
): EvalSafeShellEnvResult {
  const env = createSanitizedEnv(extra);
  if (process.env.CODE_AGENT_EVAL_REAL_ROOT !== undefined) {
    delete env.CODE_AGENT_EVAL_REAL_ROOT;
    delete env.AUTO_TEST_API_KEY;
    delete env.AUTO_TEST_BASE_URL;
    delete env.NEO_SCRIPTED_APPROVAL_POLICY;
  }

  // A8 env secret whitelist: strip secret-looking vars (*_KEY/*_TOKEN/
  // *_SECRET/...) from the CHILD process env. This module is shared by
  // CLI/desktop/web, so the filter applies on all three ends by default
  // (intended — A8 is P0). The AGENT process itself is untouched: it keeps
  // its own process.env with provider API keys for model calls.
  // Escape hatch: [env_filter] in code-agent-policy.toml
  // (strip_secret_vars=false, or allowed_secret_vars=[...]).
  const envFilter = getEnvFilterPolicy(projectDir);
  if (!envFilter.strip_secret_vars) return { ok: true, env };
  const { env: filtered, strippedNames } = filterSecretEnvVars(env, {
    allowedNames: envFilter.allowed_secret_vars,
  });
  if (strippedNames.length === 0) return { ok: true, env: filtered };

  // Names only — values must never touch logs.
  logger?.debug('Bash child env: stripped secret-looking vars', { names: strippedNames });

  // ADR-066 刀 2（D4）：被剥的名字不是删成「没有」，而是注入
  // `secureref:env.<NAME>` 占位；真值留在本调用的内存快照（不落盘、不进
  // SecureStorage）。仅当这一跳放网时按需回填全部注入过的名字；非放网跳
  // 子进程只能看到引用串。变量名含 '.'/':' 无法编码 → 跳过注入、保持 strip。
  const injection = injectEnvSecretRefs(filtered, strippedNames, env);
  if (injection.skippedNames.length > 0) {
    logger?.debug('Bash child env: secret var names not encodable as secureref, kept stripped', {
      names: injection.skippedNames,
    });
  }
  const refilled = backfillEnvSecretRefs(
    injection.env,
    injection.snapshot,
    refill ?? { allowNetwork: false, command: '' },
  );
  if (!refilled.ok) {
    // fail-closed：不 exec，稳定 code 交 renderer 翻译；错误串只带 env.NAME。
    logger?.warn('Bash child env: unresolved env secret reference, refusing to exec', {
      code: refilled.code,
    });
    return refilled;
  }
  return { ok: true, env: refilled.env };
}
