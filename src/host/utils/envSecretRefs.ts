// ============================================================================
// Env Secret References (ADR-066 刀 2 — bash 子进程凭据哨兵)
//
// 链路（D4）：
//   1. filterSecretEnvVars 仍按名 strip（本模块不改变识别口径）。
//   2. 被剥的名字在子进程 env 里注入 `secureref:env.<NAME>` 占位
//      （integrationId=env，field=变量名；复用 ADR-050 encodeSecretRef 的约束，
//      两者不得含 '.'/':'——变量名违规时跳过注入、保持 strip，不崩溃）。
//      真值只留在本文件返回的内存快照里，随 spawn 这一跳生灭，不落盘、
//      不进 SecureStorage、绝不进日志/错误串。
//   3. 仅当这一跳放网（resolveSandboxNetworkPolicy=true）时，backfill 把
//      全部注入过的引用解回真值——npm/gh 这类工具从 env 读凭据，命令文本里
//      看不到 $NPM_TOKEN，所以回填不按文本出现与否过滤。
//   4. Fail-closed：命令文本里出现 $FOO 而 FOO 的引用解不开 → 不 exec，
//      稳定 code SECRET_REF_UNRESOLVED；禁止空串顶上（ADR-050 同一条）。
//      lookup 失败的错误串只带 env.NAME，不带真值。
//
// 非放网跳不回填：子进程 echo $GITHUB_TOKEN 只能打出引用串。
// MCP 消费路径（mcpSecretResolver）不经过本模块，零回归面。
// ============================================================================

import { encodeSecretRef, parseSecretRef } from '../mcp/secretRef';

const ENV_SECRET_REFILL_ERROR_CODE = 'SECRET_REF_UNRESOLVED';

const ENV_INTEGRATION_ID = 'env';

export interface EnvSecretInjection {
  /** 注入占位后的子进程 env（新对象，输入不被修改）。 */
  env: Record<string, string>;
  /** 成功注入引用的变量名。 */
  injectedNames: string[];
  /** 名字含 '.'/':' 无法编码为无歧义引用 → 未注入、保持 strip 的变量名。 */
  skippedNames: string[];
  /** 被剥变量的真值快照（仅宿主内存，供放网跳回填；绝不进日志）。 */
  snapshot: Record<string, string>;
}

/**
 * 把被 strip 的变量以 `secureref:env.<NAME>` 占位形式注回子进程 env。
 * `sourceEnv` 是 strip 之前的完整 env（真值来源），只进内存快照。
 */
export function injectEnvSecretRefs(
  filteredEnv: Record<string, string>,
  strippedNames: readonly string[],
  sourceEnv: Record<string, string>,
): EnvSecretInjection {
  const env = { ...filteredEnv };
  const injectedNames: string[] = [];
  const skippedNames: string[] = [];
  const snapshot: Record<string, string> = {};

  for (const name of strippedNames) {
    const value = sourceEnv[name];
    if (value === undefined) continue;
    try {
      env[name] = encodeSecretRef(ENV_INTEGRATION_ID, name);
    } catch {
      // 变量名含 '.'/':'：无法编成无歧义引用。处置 = 跳过注入、保持 strip。
      skippedNames.push(name);
      continue;
    }
    injectedNames.push(name);
    snapshot[name] = value;
  }

  return { env, injectedNames, skippedNames, snapshot };
}

export interface EnvSecretRefillOptions {
  /** 这一跳是否放网；false 时引用原样保留（非网络命令不解）。 */
  allowNetwork: boolean;
  /** 本跳命令文本，用于 fail-closed 判定（$FOO 出现且解不开 → 不 exec）。 */
  command: string;
}

export type EnvSecretRefillResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string; code: typeof ENV_SECRET_REFILL_ERROR_CODE };

/** 命令文本是否引用了该环境变量（$FOO / ${FOO} / ${FOO:-x} / ${#FOO} 等形态）。 */
function commandReferencesEnvVar(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\$\\{#?${escaped}(?=[\\s}:/=%+?-])|\\$${escaped}(?![A-Za-z0-9_])`,
  ).test(command);
}

/**
 * 放网跳把 env 里的 `secureref:env.*` 引用解回真值；非放网跳原样返回。
 * 只解 integrationId=env 的引用；其它 integrationId 的引用串只是普通数据，不动。
 */
export function backfillEnvSecretRefs(
  env: Record<string, string>,
  snapshot: Record<string, string>,
  options: EnvSecretRefillOptions,
): EnvSecretRefillResult {
  const refs: Array<{ key: string; field: string }> = [];
  for (const [key, value] of Object.entries(env)) {
    const reference = parseSecretRef(value);
    if (reference?.integrationId === ENV_INTEGRATION_ID) {
      refs.push({ key, field: reference.field });
    }
  }
  if (refs.length === 0 || !options.allowNetwork) {
    return { ok: true, env };
  }

  const resolved = { ...env };
  for (const { key, field } of refs) {
    const value = snapshot[field];
    if (value !== undefined) {
      resolved[key] = value;
      continue;
    }
    if (commandReferencesEnvVar(options.command, field)) {
      // fail-closed：错误串只带 env.NAME，真值绝不入内；禁止空串顶上。
      return {
        ok: false,
        error:
          `environment credential "env.${field}" could not be resolved; ` +
          'refusing to run the command with an unresolved secret reference',
        code: ENV_SECRET_REFILL_ERROR_CODE,
      };
    }
    // 文本未引用：保留引用占位符（不落空串、不崩溃），命令多半不需要它。
  }
  return { ok: true, env: resolved };
}
