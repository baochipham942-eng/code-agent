// ============================================================================
// Jev CUA step candidates — desktop AX candidate prep before systemOne
// ============================================================================
// N-JEV-CU-STEP-LOOP. Pure projection of one `ComputerUseStateViewV1` into the
// candidate window Jev is allowed to see. The rules come from
// docs/architecture/designs/jev-cu-step.md (① 候选行 / ③ 安全不退 / ⑨):
//
// - Candidate rows carry ref/role/label/depth/parentRef/hasValue ONLY. Raw
//   `value` (could be typed secrets) and `frame` (a coordinate click channel
//   that would bypass elementRef) never enter the Jev state.
// - Secure text fields and file-picker controls are dropped BEFORE compression;
//   the state keeps only a `sensitive_fields_present` boolean, no labels.
// - Compression cap is 254 refs (buildCuTargetQuestion adds `no_target` to
//   reach the 255 choice-key limit): task-word overlap first, then interactive
//   roles (button/text/menu), then original AX order.
// - Root-window selection: explicit {pid, windowId} wins; otherwise word
//   overlap of the task against on-screen window app names/titles, and 0 or
//   >1 matches hand back with the roots listed. DEFAULT_DENIED_APPS windows
//   never get selected by the loop.

import type {
  ComputerUseElementViewV1,
  ComputerUseRootRefV1,
} from '../../../../shared/contract/desktop';
import { DEFAULT_DENIED_APPS } from '../../../services/desktop/computerSurfaceSafety';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';

/** 目标窗上限：加上 no_target 哨兵后 choice 键恰好 255。 */
const CUA_JEV_TARGET_CAP = 254;
/** 候选 label 截断长度（guard 之后截，保证最终长度受控）。 */
const CUA_JEV_LABEL_CHARS = 80;

/** 密码控件：AX 树里唯一确定性的密码信号（公开元素无 subrole/TCC 位，不猜别的）。 */
const CU_SECURE_ROLE = /^axsecuretextfield$/i;
/** 文件选择控件：role 或 label 命中文件选择形态才丢，认不出就不丢（设计稿：不猜）。 */
const CU_FILE_ROLE = /file/i;
const CU_FILE_LABEL = /^(?:choose\s+files?|select\s+files?|选取?文件|浏览文件|文件选择|open\s+file|save\s+file)\??$/i;

/** role 属于按钮/文本/菜单项等可交互控件时压缩优先（设计稿 ①：任务词 → role → AX 原序）。 */
const CU_INTERACTIVE_ROLE = /button|text|menu|link|tab|checkbox|radio|switch|combobox|pop|search|slider/i;

/** 风险升级关键词（标签命中 delete/pay/authorize/upload/captcha/system-settings 语义）。 */
export const CU_RISK_KEYWORD = /pay|payment|purchase|checkout|购买|支付|delete|删除|移除|erase|authorize|authorisation|authorization|oauth|授权|grant(?:ing)?\s+access|upload|上传|captcha|验证码|system\s+settings?|系统设置|系统偏好|preferences?|keychain|钥匙串/i;

/** 进 Jev 的候选行。没有 value、没有 frame —— 这两列在投影层就被剥掉。 */
interface CuJevCandidate {
  ref: string;
  role: string;
  label: string;
  depth: number | null;
  parentRef?: string;
  hasValue: boolean;
}

export interface PreparedCuJevCandidates {
  candidates: CuJevCandidate[];
  /** choice criteria 用的 ref → label 表（与 candidates 同序同键）。 */
  labels: Record<string, string>;
  /** observe 原始元素数。 */
  rawCount: number;
  /** 丢掉敏感控件之后的元素数（压缩前）。 */
  filteredCount: number;
  /** 原始树里有密码/文件控件（布尔，不带标签）。 */
  sensitiveFieldsPresent: boolean;
}

/** 密码/文件控件判定：压缩之前丢，不出现在 targets 里。 */
// internal: 敏感控件判定只进 prepareCuJevCandidates 的过滤口
function isCuSensitiveElement(element: ComputerUseElementViewV1): boolean {
  if (CU_SECURE_ROLE.test(element.role)) return true;
  if (CU_FILE_ROLE.test(element.role)) return true;
  const label = element.label?.trim() ?? '';
  if (label && CU_FILE_LABEL.test(label)) return true;
  return false;
}

function guardLabel(label: string | null | undefined): string {
  const guarded = guardSensitiveText(label ?? '', {
    surface: 'prompt',
    mode: 'model-context',
    maxLength: CUA_JEV_LABEL_CHARS,
  });
  return guarded.slice(0, CUA_JEV_LABEL_CHARS);
}

/** 任务词表：小写、按非字母数字切、丢单字符（拉丁）/单字（CJK 由子串覆盖）。 */
function cuTaskTokens(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function taskOverlapScore(label: string, role: string, taskTokens: string[]): number {
  const haystack = `${label} ${role}`.toLowerCase();
  let score = 0;
  for (const token of taskTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

/**
 * 把一份 observe state 投影成 Jev 候选窗：丢敏感控件 → 打分压缩到 ≤254 →
 * 逐行脱敏截断。rawCount>0 且过滤后为 0 时返回空 candidates（调用方交回，
 * 不允许点选回落——那是 empty_ax 的专属路径）。
 */
export function prepareCuJevCandidates(
  elements: readonly ComputerUseElementViewV1[],
  task: string,
): PreparedCuJevCandidates {
  const tokens = cuTaskTokens(task);
  let sensitiveFieldsPresent = false;
  const kept: Array<{ element: ComputerUseElementViewV1; score: number; roleRank: number; index: number }> = [];
  elements.forEach((element, index) => {
    if (isCuSensitiveElement(element)) {
      sensitiveFieldsPresent = true;
      return;
    }
    kept.push({
      element,
      index,
      score: taskOverlapScore(element.label ?? '', element.role, tokens),
      roleRank: CU_INTERACTIVE_ROLE.test(element.role) ? 1 : 0,
    });
  });
  kept.sort((a, b) =>
    b.score - a.score
    || b.roleRank - a.roleRank
    || a.index - b.index);
  const selected = kept.slice(0, CUA_JEV_TARGET_CAP);
  const candidates: CuJevCandidate[] = selected.map(({ element }) => ({
    ref: element.ref,
    role: element.role,
    label: guardLabel(element.label),
    depth: typeof element.depth === 'number' ? element.depth : null,
    ...(element.parentRef ? { parentRef: element.parentRef } : {}),
    hasValue: typeof element.value === 'string' && element.value.length > 0,
  }));
  const labels: Record<string, string> = {};
  for (const candidate of candidates) {
    labels[candidate.ref] = candidate.label || candidate.role;
  }
  return {
    candidates,
    labels,
    rawCount: elements.length,
    filteredCount: kept.length,
    sensitiveFieldsPresent,
  };
}

type CuRootSelectionReason =
  | 'no_match'
  | 'ambiguous'
  | 'denied_app'
  | 'not_found';

export interface CuRootSelection {
  root: ComputerUseRootRefV1 | null;
  /** 交回时给主模型看的根列表（不过滤 denied apps：主模型走既有审批/TCC）。 */
  handbackRoots: ComputerUseRootRefV1[];
  reason?: CuRootSelectionReason;
}

// internal: denied-app 判定只在 selectCuRootWindow 里用（含显式 target 校验）
function isCuDeniedApp(appName: string | null | undefined): boolean {
  const name = appName?.trim();
  if (!name) return false;
  return DEFAULT_DENIED_APPS.some((denied) => denied.toLowerCase() === name.toLowerCase());
}

function windowTokens(root: ComputerUseRootRefV1): string[] {
  return `${root.appName ?? ''} ${root.title ?? ''}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

/**
 * 根窗口选择（设计稿 ①：Jev 不选 App）。显式 target 优先（校验存在 +
 * 非 denied app）；无 target 时任务词交叠打分，0 或 >1 个匹配交回并把根列表
 * 带回给主模型。denied app 的窗口永远不被环选中。
 */
export function selectCuRootWindow(args: {
  roots: readonly ComputerUseRootRefV1[];
  task: string;
  target?: { pid: number; windowId: number };
}): CuRootSelection {
  if (args.target) {
    const wanted = args.target;
    const found = args.roots.find((root) => root.pid === wanted.pid && root.windowId === wanted.windowId);
    if (!found) {
      return { root: null, handbackRoots: [...args.roots], reason: 'not_found' };
    }
    if (isCuDeniedApp(found.appName)) {
      return { root: null, handbackRoots: [...args.roots], reason: 'denied_app' };
    }
    return { root: found, handbackRoots: [...args.roots] };
  }
  const taskText = args.task.toLowerCase();
  const eligible = args.roots.filter((root) => !isCuDeniedApp(root.appName));
  const matches = eligible.filter((root) =>
    windowTokens(root).some((token) => taskText.includes(token)));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    return { root: only, handbackRoots: [...args.roots] };
  }
  return {
    root: null,
    handbackRoots: [...args.roots],
    reason: matches.length === 0 ? 'no_match' : 'ambiguous',
  };
}
