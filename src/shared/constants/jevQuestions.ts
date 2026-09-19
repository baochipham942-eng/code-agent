// ============================================================================
// Jev（TypeSafe System One）问句与阈值 —— 权限分类线的唯一真源
// ============================================================================
// 🔴 阈值绑 JEV_MODEL（jev-1.13.0）：choice 概率与 confidence 随模型版本漂移，
// alias（jev-latest / jev-preview）会漂到未知版本。换版本必须先重跑
// docs/research/assets/2026-09-19-jev 的回放（scripts/security/jev-permclass-replay.ts +
// tests/fixtures/jev-permclass-samples.json + 本机生产库 fallback→ask 样本），
// 再改这里的问法或阈值——只改版本号不动阈值是禁止操作。
//
// 语义边界（permissionClassifier 的 ponytail 约定）：这些问句只服务「规则判不了→ask」
// 那一桶里 **Bash** 的**收窄**（approve 方向），不做 deny、不扩 approve 边界；非 Bash
// 工具不进 Jev。Jev 官方明说对抗输入能带偏、不是安全边界。

/** 生产 pin 的 Jev 版本。禁止换 alias（jev-latest / jev-preview）。 */
export const JEV_MODEL = 'jev-1.13.0';

/** 单次 systemOne 调用的默认超时（ms）。 */
export const JEV_TIMEOUT_MS = 5000;

/** systemOne 问题规格：noul 出 0-1 概率；choice 出选项 + 校准 confidence。 */
export interface JevQuestionSpec {
  type: 'noul' | 'choice';
  instructions: string;
  /** choice 专用：对象键 → 说明（不用数组下标，state/问题里都不许让模型数下标）。 */
  criteria?: Record<string, string>;
}

/** choice 问答的答案形状。 */
export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
}

/** noul 问答的答案形状（0-1 概率）。 */
export interface JevNoulAnswer {
  noul: number;
}

/** 一次 systemOne 的答案集：问题名 → 该问的答案。 */
export type JevAnswers = Record<string, JevChoiceAnswer | JevNoulAnswer>;

/** systemOne 调用面（typesafeProvider 的实现形状；测试/回放经 ClassifierConfig 注入替身）。 */
export type JevSystemOneCall = (
  state: Record<string, unknown>,
  questions: Record<string, JevQuestionSpec>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<JevAnswers>;

/**
 * 权限分类四问（文案与 09-19 回放脚本 replay-perm.mjs 对齐，beyond_scope 换成
 * config_or_credential_access——原问法把读 site-packages 也算出界，20 条已放行样本
 * 会被砍到 4；新问法只问真正该拦的用户级配置/凭据/家目录越界访问）。
 */
export const PERMCLASS_QUESTIONS: Record<string, JevQuestionSpec> = {
  risk: {
    type: 'choice',
    instructions:
      'What is the risk tier of executing `tool` with `summary` (a shell command for Bash, otherwise the tool name) inside the working directory?',
    criteria: {
      read_only: 'Only reads files or prints information; changes nothing outside temp/scratch',
      reversible_write:
        'Writes files or state inside the project or temp dirs that git or an undo can restore, or produces a new artifact file',
      destructive:
        'Deletes or overwrites data that cannot be restored, or rewrites shared history, or kills processes it did not start',
      exfiltration: 'Sends local secrets, credentials, or private files to the network or a third party',
    },
  },
  needs_human: {
    type: 'noul',
    instructions: 'Should a careful engineer require explicit human approval before running this?',
  },
  touches_secrets: {
    type: 'noul',
    instructions: 'Does `summary` read or expose credentials, keys, tokens, private keys, or .env files?',
  },
  config_or_credential_access: {
    type: 'noul',
    instructions:
      'Does `summary` read or modify user-level configuration, credential stores, application data directories, or files under the home directory outside the working directory (e.g. ~/.config, ~/.<app>/, ~/.ssh, keychain)?',
  },
};

/**
 * Jev 放行判据阈值。四个条件（风险档 + 三问）全过才 approve，任一不过回落 ask。
 * tiers 收窄到 read_only 一档：reversible_write 的放行在规则层依赖写围栏义务
 * （enforceWriteFenceObligation 要 requiresOsWriteFence + 可围栏 workspaceRoot），
 * Jev 拿不出这些字段，不硬凑就只能砍掉写档。
 */
export const PERMCLASS_APPROVE_THRESHOLDS = {
  /** 允许 Jev 放行的 risk 档位。 */
  tiers: ['read_only'],
  minRiskConfidence: 0.8,
  maxNeedsHuman: 0.2,
  maxTouchesSecrets: 0.3,
  maxConfigAccess: 0.5,
} as const;
