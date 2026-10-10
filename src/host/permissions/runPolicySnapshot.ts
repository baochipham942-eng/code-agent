// ============================================================================
// N-PERM-POLICYVERSION ②③ — run 级权限快照与有效视图（effective view）
// ============================================================================
//
// 决议（编排 2026-09-30，方案 B）：
//   · 收紧（加 deny/prompt 规则、删 allow 规则、档位变严）——任何来源，立即生效；
//   · 放宽（删/降 deny 规则、加 allow 规则、档位抬宽）——只有来源是 'user-ui' 才对
//     已开始的 run 生效；外部来源（config 热重载/hook/plugin/项目设置）冻结在 run
//     起点的水位线，下一个 run 起生效。
//
// 结构：beginRunPolicy 在 run 起点深拷贝规则/执行策略/会话有效档/PolicyEnforcer 状态，
// 并记下流水水位线；之后每次变更都带来源写进流水（policyMutationSource）。
// 消费端（E1-E6）不再直读活状态，改读这里的有效视图。没有快照的路径（CLI/eval/
// 从不 begin 的测试）视图 === 活状态，行为与 origin/main 完全一致。
//
// 子代理不穿 runId：模块内维护 sessionId → 最新活跃 run 的映射，E6 侧只传 sessionId。

import {
  currentPolicyMutationSeq,
  policyMutationsSince,
  trimPolicyMutationsAtOrBelow,
  type PolicyMutationEntry,
} from './policyMutationSource';
import { getPermissionModeManager, permissionModeAutoApproves, type PermissionMode } from './modes';
import { getPolicyEngine, type PolicyRule } from './policyEngine';
import {
  getExecPolicyStore,
  resolvePolicyDecision,
  type PolicyDecision,
  type PrefixRule,
} from '../security/execPolicy';
import {
  getPolicyEnforcer,
  PolicyEnforcer,
  type PolicyEnforcerState,
} from '../security/policyEnforcer';

// ----------------------------------------------------------------------------
// 快照存储
// ----------------------------------------------------------------------------

interface RunPolicySnapshot {
  runId: string;
  sessionId?: string;
  /** run 起点的流水水位线；seq 大于它的变更才参与本 run 的冻结判定。 */
  watermark: number;
  /** 捕获失败 = undefined → 该组件回落活状态（收紧仍立即生效，只是不冻结）。 */
  rules?: PolicyRule[];
  execRules?: PrefixRule[];
  mode?: PermissionMode;
  /** null = run 起点没有活跃的 policy 文件（出现新文件是收紧，走活状态）。 */
  enforcer?: PolicyEnforcerState | null;
}

const runsById = new Map<string, RunPolicySnapshot>();
/** 每个会话的活跃 run 栈（begin 压栈、end 出栈）：子代理/E6 按「最新活跃 run」解析快照。 */
const activeRunsBySession = new Map<string, string[]>();

/** 引擎从不原地改规则（add 只 push、remove 只 splice），逐条浅拷贝即够深。 */
function cloneRule(rule: PolicyRule): PolicyRule {
  return { ...rule, matcher: { ...rule.matcher } };
}

function execRuleId(rule: PrefixRule): string {
  return rule.pattern.join(' ');
}

function findRunSnapshot(runId?: string, sessionId?: string): RunPolicySnapshot | undefined {
  if (runId) {
    const byId = runsById.get(runId);
    if (byId) return byId;
  }
  if (sessionId) {
    const stack = activeRunsBySession.get(sessionId);
    const latest = stack?.[stack.length - 1];
    if (latest) return runsById.get(latest);
  }
  return undefined;
}

function trimJournalToActiveSnapshots(): void {
  if (runsById.size === 0) {
    trimPolicyMutationsAtOrBelow(currentPolicyMutationSeq());
    return;
  }
  let minWatermark = Number.POSITIVE_INFINITY;
  for (const snapshot of runsById.values()) {
    if (snapshot.watermark < minWatermark) minWatermark = snapshot.watermark;
  }
  trimPolicyMutationsAtOrBelow(minWatermark);
}

/**
 * run 起点冻结基线。在 agentOrchestrator 里紧随角色档写入之后调用——专家自带的
 * 审批档是本轮基线的一部分；finally 里配对 endRunPolicy。
 */
export function beginRunPolicy(runId: string, sessionId?: string): void {
  const watermark = currentPolicyMutationSeq();
  let rules: PolicyRule[] | undefined;
  try {
    rules = getPolicyEngine().getRules().map(cloneRule);
  } catch {
    rules = undefined;
  }
  let execRules: PrefixRule[] | undefined;
  try {
    execRules = getExecPolicyStore().getRules().map((rule) => ({ ...rule }));
  } catch {
    execRules = undefined;
  }
  let mode: PermissionMode | undefined;
  try {
    mode = getPermissionModeManager().getModeForSession(sessionId);
  } catch {
    mode = undefined;
  }
  let enforcer: PolicyEnforcerState | null | undefined;
  try {
    enforcer = getPolicyEnforcer()?.captureState() ?? null;
  } catch {
    enforcer = undefined;
  }
  runsById.set(runId, { runId, sessionId, watermark, rules, execRules, mode, enforcer });
  if (sessionId) {
    const stack = activeRunsBySession.get(sessionId) ?? [];
    stack.push(runId);
    activeRunsBySession.set(sessionId, stack);
  }
  trimJournalToActiveSnapshots();
}

/** run 终点丢快照。未 begin 过的 runId 是无害 no-op。同会话还有活跃 run 时回落到次新的。 */
export function endRunPolicy(runId: string): void {
  const snapshot = runsById.get(runId);
  if (!snapshot) return;
  runsById.delete(runId);
  if (snapshot.sessionId) {
    const stack = (activeRunsBySession.get(snapshot.sessionId) ?? []).filter((id) => id !== runId);
    if (stack.length === 0) activeRunsBySession.delete(snapshot.sessionId);
    else activeRunsBySession.set(snapshot.sessionId, stack);
  }
  trimJournalToActiveSnapshots();
}

// ----------------------------------------------------------------------------
// 有效视图：规则 / exec 规则 / 档位
// ----------------------------------------------------------------------------

/** 外部来源的放宽要被冻结掉的变更；收紧与 user-ui 变更原样放行活状态。 */
function externalMutationsSince(watermark: number): PolicyMutationEntry[] {
  return policyMutationsSince(watermark).filter((entry) => entry.source === 'external');
}

function applyRuleFreeze(live: PolicyRule[], snapshot: RunPolicySnapshot): PolicyRule[] {
  if (!snapshot.rules) return live;
  const snapById = new Map(snapshot.rules.map((rule) => [rule.id, rule] as const));
  // 冻结掉：起点不存在、由外部加进来的 allow 规则（加白名单 = 放宽）。
  const frozenAway = new Set<string>();
  // 找回来：起点存在、被外部删掉的 deny/prompt 规则（删 deny = 放宽）。
  const restored = new Map<string, PolicyRule>();
  for (const entry of externalMutationsSince(snapshot.watermark)) {
    if (entry.kind === 'rule-add') {
      if (entry.action === 'allow' && !snapById.has(entry.id)) frozenAway.add(entry.id);
    } else if (entry.kind === 'rule-remove') {
      const baseline = snapById.get(entry.id);
      if ((entry.action === 'deny' || entry.action === 'prompt') && baseline) {
        restored.set(entry.id, baseline);
      }
    }
  }
  if (frozenAway.size === 0 && restored.size === 0) return live;
  const rules = live.filter((rule) => !frozenAway.has(rule.id));
  for (const [id, baseline] of restored) {
    if (!rules.some((rule) => rule.id === id)) rules.push(baseline);
  }
  return rules;
}

/**
 * 档位宽窄序（写成注释的规则）：
 * “更宽” = 该档免确认（permissionModeAutoApproves）的层级是另一档的真超集——
 * 层级集合上 {∅(default 等) ⊂ {write}(acceptEdits) ⊂ {write,execute}(bypassPermissions)}
 * 是全序，所以只需 “∃层级：live 免确认而起点档不免确认” 即严格更宽；反之（更窄或
 * 同宽异档，如 default→plan/dontAsk）一律按收紧处理——活状态在这些档位上不可能
 * 比起点档多免确认任何操作，直接应用不会放宽审批。
 */
function isStrictlyLooserMode(live: PermissionMode, baseline: PermissionMode): boolean {
  return (permissionModeAutoApproves(live, 'write') && !permissionModeAutoApproves(baseline, 'write'))
    || (permissionModeAutoApproves(live, 'execute') && !permissionModeAutoApproves(baseline, 'execute'));
}

function effectiveModeFor(snapshot: RunPolicySnapshot | undefined, sessionId?: string): PermissionMode {
  const manager = getPermissionModeManager();
  const live = manager.getModeForSession(sessionId);
  if (snapshot?.mode === undefined) return live;
  // 用户在 UI 里动过档（含任何作用域——本会话或全局默认档都能移动这个会话的基线）
  // → 跟随最新意图，立即生效。
  const userUiTouched = policyMutationsSince(snapshot.watermark).some(
    (entry) => entry.kind === 'mode' && entry.source === 'user-ui',
  );
  if (userUiTouched) return live;
  // 外部抬宽 → 冻结在起点档；收紧/同宽异档 → 活状态。动态钳制（首跑/无人值守/
  // 语音抬严/限流）只收紧不放宽且可中途置位，叠在冻结基线之上，收紧仍立即生效。
  if (!isStrictlyLooserMode(live, snapshot.mode)) return live;
  return manager.applyDynamicClamps(snapshot.mode, sessionId);
}

/** E1/E6：会话有效档（无快照路径 === getModeForSession，与 origin/main 一致）。 */
export function resolveEffectiveSessionMode(sessionId?: string): PermissionMode {
  return effectiveModeFor(findRunSnapshot(undefined, sessionId), sessionId);
}

/** E2/E3：用户规则引擎的有效规则列表。 */
export function resolveEffectivePolicyRules(sessionId?: string): PolicyRule[] {
  const live = getPolicyEngine().getRules();
  const snapshot = findRunSnapshot(undefined, sessionId);
  if (!snapshot) return live;
  return applyRuleFreeze(live, snapshot);
}

/** E5：按有效 exec 规则匹配命令决策（null = 不命中，走常规权限流程）。 */
export function matchEffectiveExecPolicy(command: string, sessionId?: string): PolicyDecision | null {
  const store = getExecPolicyStore();
  const snapshot = findRunSnapshot(undefined, sessionId);
  if (!snapshot?.execRules) return store.match(command);
  const snapIds = new Set(snapshot.execRules.map(execRuleId));
  const frozenAway = new Set<string>();
  for (const entry of externalMutationsSince(snapshot.watermark)) {
    // 学来的/外部加的 allow 前缀 = 放宽，起点没有就冻结掉；forbidden = 收紧，保留。
    if (entry.kind === 'exec-add' && entry.action === 'allow' && !snapIds.has(entry.id)) {
      frozenAway.add(entry.id);
    }
  }
  if (frozenAway.size === 0) return store.match(command);
  const rules = store.getRules().filter((rule) => !frozenAway.has(execRuleId(rule)));
  return resolvePolicyDecision(rules, command);
}

/** 一个 run 的完整有效视图（账本哈希与测试消费；纯读，无副作用）。 */
export interface EffectivePolicyView {
  rules: PolicyRule[];
  execRules: readonly PrefixRule[];
  mode: PermissionMode;
}

export function resolveEffectivePolicy(runId?: string, sessionId?: string): EffectivePolicyView {
  const snapshot = findRunSnapshot(runId, sessionId);
  const sid = snapshot?.sessionId ?? sessionId;
  const liveRules = getPolicyEngine().getRules();
  const store = getExecPolicyStore();
  let execRules: readonly PrefixRule[] = store.getRules();
  if (snapshot?.execRules) {
    const snapIds = new Set(snapshot.execRules.map(execRuleId));
    const frozenAway = new Set<string>();
    for (const entry of externalMutationsSince(snapshot.watermark)) {
      if (entry.kind === 'exec-add' && entry.action === 'allow' && !snapIds.has(entry.id)) {
        frozenAway.add(entry.id);
      }
    }
    if (frozenAway.size > 0) execRules = execRules.filter((rule) => !frozenAway.has(execRuleId(rule)));
  }
  return {
    rules: snapshot ? applyRuleFreeze(liveRules, snapshot) : liveRules,
    execRules,
    mode: effectiveModeFor(snapshot, sid),
  };
}

// ----------------------------------------------------------------------------
// E4：PolicyEnforcer（code-agent-policy.toml）的冻结视图
// ----------------------------------------------------------------------------

function isSubsetOf(candidate: readonly string[], superset: readonly string[]): boolean {
  return candidate.every((item) => superset.includes(item));
}

/**
 * 逐维度合并：live 相对起点变宽的维度回填起点值（外部放宽 → 冻结），变窄/不变的
 * 维度保留 live（收紧立即生效）。混合变更（某维度收紧、另一维度放宽）也按维度各归各。
 * 返回 null 表示没有任何放宽维度，直接用 live 实例。
 */
function mergeEnforcerState(
  live: PolicyEnforcerState,
  baseline: PolicyEnforcerState,
): PolicyEnforcerState | null {
  if (!live.active && baseline.active) return baseline; // 整个策略文件消失 = 全维度放宽
  if (live.active && !baseline.active) return null; // 起点本就没生效，出现文件是收紧
  const policy = structuredClone(live.policy);
  let loosened = false;

  // deny 清单变短 = 放宽 → 回填起点
  const restoreDenyList = (liveList: readonly string[], snapList: readonly string[]): readonly string[] => {
    if (liveList.length < snapList.length && isSubsetOf(liveList, snapList)) {
      loosened = true;
      return snapList;
    }
    return liveList;
  };
  // allowlist 变长 = 放宽 → 回填起点
  const restoreAllowList = (liveList: readonly string[], snapList: readonly string[]): readonly string[] => {
    if (liveList.length > snapList.length && isSubsetOf(snapList, liveList)) {
      loosened = true;
      return snapList;
    }
    return liveList;
  };

  policy.filesystem.denied_paths = [...restoreDenyList(policy.filesystem.denied_paths, baseline.policy.filesystem.denied_paths)];
  policy.filesystem.denied_file_patterns = [...restoreDenyList(policy.filesystem.denied_file_patterns, baseline.policy.filesystem.denied_file_patterns)];
  policy.filesystem.writable_paths = [...restoreAllowList(policy.filesystem.writable_paths, baseline.policy.filesystem.writable_paths)];
  policy.execution.denied_commands = [...restoreDenyList(policy.execution.denied_commands, baseline.policy.execution.denied_commands)];
  policy.execution.allowed_command_prefixes = [...restoreAllowList(policy.execution.allowed_command_prefixes, baseline.policy.execution.allowed_command_prefixes)];
  policy.tools.disabled = [...restoreDenyList(policy.tools.disabled, baseline.policy.tools.disabled)];
  policy.tools.always_confirm = [...restoreDenyList(policy.tools.always_confirm, baseline.policy.tools.always_confirm)];
  policy.network.allowed_domains = [...restoreAllowList(policy.network.allowed_domains, baseline.policy.network.allowed_domains)];
  policy.model.allowed_providers = [...restoreAllowList(policy.model.allowed_providers, baseline.policy.model.allowed_providers)];
  if (!policy.network.allow && baseline.policy.network.allow) {
    loosened = true;
    policy.network.allow = true;
  }
  if (!policy.execution.allow_shell && baseline.policy.execution.allow_shell) {
    loosened = true;
    policy.execution.allow_shell = true;
  }
  return loosened ? { projectDir: live.projectDir, active: live.active, policy } : null;
}

/**
 * E4：有效 enforcer。run 起点没捕获到状态（捕获失败或当时还没绑定单例）时原样返回
 * live——行为与 origin/main 一致；toml 本身没有 watcher，run 内重新读盘只会发生在
 * 工作区重绑，重绑变宽的维度由这里的冻结挡住。
 */
export function resolveEffectivePolicyEnforcer(
  live: PolicyEnforcer | null,
  sessionId?: string,
): PolicyEnforcer | null {
  const snapshot = findRunSnapshot(undefined, sessionId);
  const baseline = snapshot?.enforcer;
  if (!live || baseline === undefined || baseline === null) return live;
  if (!live.isActive) return PolicyEnforcer.fromState(baseline);
  const merged = mergeEnforcerState(live.captureState(), baseline);
  return merged ? PolicyEnforcer.fromState(merged) : live;
}
