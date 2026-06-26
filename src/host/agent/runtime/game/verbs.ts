/**
 * Verb taxonomy — 6-class library + declarative predicate interpreter.
 *
 * 与 内部文档 §4.4 跨流派词汇表对齐。
 *
 * 核心职责：
 * 1. VERB_REGISTRY: 通用 verb 元信息（class / 描述 / 常见 selector / 默认 success predicate）
 * 2. extractByPath: dotted + array index 的 snapshot 字段提取
 * 3. evaluatePredicate / evaluatePredicateWithReason: declarative predicate runtime
 *
 * 这一层**没有任何 subtype-specific 逻辑**。platformer 的 stomp 在 task C 里
 * 实现成 `defeat` 的一个 VerbDeclaration，不是这里的硬编码概念。
 */

import type { PredicateExpr, Snapshot, VerbClass, VerbId } from './types';

// ---------------------------------------------------------------------------
// Verb metadata
// ---------------------------------------------------------------------------

/**
 * 单个 verb 的通用元信息 — 用于:
 * - 给 LLM 看 description（generation prompt 注入）
 * - subtype 在写 selector 时有 commonSelectors 可参考
 * - subtype 没显式给 successPredicate 时 fallback 到 defaultSuccess
 */
export interface VerbMetadata {
  /** 6-class 中的归类 */
  class: VerbClass;
  /** 简短描述 — 给 LLM/dev 读的 */
  description: string;
  /**
   * 该 verb 在 snapshot 里常见的 selector 形态。
   * 字符串为精确路径（dotted），RegExp 为路径模式（用于扫描 snapshot keys）。
   */
  commonSelectors: readonly (string | RegExp)[];
  /**
   * 默认成功条件 — subtype 不显式给 success 时用这个。
   * path 用占位符 '$selector'，evaluator 在用之前会替换成 VerbDeclaration.selector。
   */
  defaultSuccess: PredicateExpr;
}

/**
 * 6-class verb 注册表 — single source of truth for cross-genre verb library.
 * 改这里前先看 docs §4.4 的表，保持类目对齐。
 */
export const VERB_REGISTRY: Record<VerbId, VerbMetadata> = {
  // -------------------- Movement --------------------
  moveTo: {
    class: 'movement',
    description: 'Player或单位主动位移到一个目标位置（walk / run / strafe）',
    commonSelectors: ['player.x', 'player.y', 'player.position', /^(player|unit)\.(x|y|position)$/],
    defaultSuccess: { op: 'change', path: '$selector' },
  },
  traverse: {
    class: 'movement',
    description: '跨越障碍 / 切换 lane / 翻越平台（jump gap / dodge lane / climb / cover）',
    commonSelectors: ['player.lane', 'player.airborne', /^player\.(jumping|climbing|onWall)$/],
    defaultSuccess: { op: 'change', path: '$selector' },
  },

  // -------------------- Acquisition --------------------
  collect: {
    class: 'acquisition',
    description: '获取 pickup / 道具 / 货币（coins / loot / ammo / keys）',
    commonSelectors: [
      'coinsCollected',
      'itemsCollected',
      'pickups',
      'inventory.length',
      /Collected$/,
    ],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },
  unlock: {
    class: 'acquisition',
    description: '解锁门 / 关卡 / tech tree 节点 / 任务 flag',
    commonSelectors: [
      'gatesUnlocked',
      'doorsUnlocked',
      'unlockedLevels',
      /Unlocked$/,
      /^unlocked/,
    ],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },

  // -------------------- Conflict --------------------
  defeat: {
    class: 'conflict',
    description: '击败敌人 / 拆塔 / shoot down（platformer stomp 是这个的特化）',
    commonSelectors: [
      'enemiesDefeated',
      'defeatedEnemies',
      'stompedEnemies',
      'kills',
      /^enemy\.(dead|defeated|stomped)$/,
    ],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },
  defend: {
    class: 'conflict',
    description: '保护 base / lane / 队友（tower defense base HP, escort 距离）',
    commonSelectors: ['baseHealth', 'lives', 'escortHealth', /Health$/],
    defaultSuccess: { op: 'eq', path: '$selector', value: true },
  },
  evade: {
    class: 'conflict',
    description: '躲避 spike / obstacle / leak（runner 闪障碍、shooter 翻滚）',
    commonSelectors: ['evadeCount', 'dodgeCount', 'spikeMisses', /Evade|Dodge/],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },

  // -------------------- Construction --------------------
  build: {
    class: 'construction',
    description: '放置 tower / 建筑 / craft 物品',
    commonSelectors: ['towersBuilt', 'buildingsBuilt', 'craftedItems', /Built$/],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },
  upgrade: {
    class: 'construction',
    description: '升级单位 / power-up / 武器 mod / 角色等级',
    commonSelectors: ['playerLevel', 'towerTier', 'weaponMod', /Level$|Tier$/],
    defaultSuccess: { op: 'increase', path: '$selector' },
  },

  // -------------------- Cognition --------------------
  solve: {
    class: 'cognition',
    description: '解开 puzzle / 安排 wave / 战术决策 / quest 逻辑',
    commonSelectors: ['puzzleSolved', 'wavesPlanned', /Solved$/, /^solved/],
    defaultSuccess: { op: 'truthy', path: '$selector' },
  },
  navigate: {
    class: 'cognition',
    description: '找到出口 / dungeon 寻路 / 地图 navigation',
    commonSelectors: ['exitReached', 'roomVisited', 'currentRoom', /Reached$/],
    defaultSuccess: { op: 'truthy', path: '$selector' },
  },

  // -------------------- Progression --------------------
  complete: {
    class: 'progression',
    description: '完成关卡 / 通关 / 达成目标（reach flag / clear board / clear stage）',
    commonSelectors: ['levelComplete', 'gameComplete', 'questDone', /Complete$/],
    defaultSuccess: { op: 'truthy', path: '$selector' },
  },
  fail: {
    class: 'progression',
    description: '失败结局 / 死亡 / party wipe / health 0',
    commonSelectors: ['gameOver', 'playerDead', 'lives', /^isDead$|GameOver$/],
    defaultSuccess: { op: 'truthy', path: '$selector' },
  },
};

/** O(1) lookup helper — 拿不到就 throw（预防笔误） */
export function getVerbMetadata(verb: VerbId): VerbMetadata {
  const meta = VERB_REGISTRY[verb];
  if (!meta) {
    // 这种情况只可能是 VerbId union 改了但 registry 没同步 — 保护性抛错
    throw new Error(`Unknown verb id: ${String(verb)}`);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Snapshot path extractor
// ---------------------------------------------------------------------------

/**
 * dotted-path + array-index extractor.
 *
 * 支持:
 * - 'a.b.c'                 → obj.a.b.c
 * - 'enemies[0].dead'       → obj.enemies[0].dead
 * - 'player.abilities.doubleJump'
 * - 'list.length'           → 数组长度（数组的 .length 是 own property）
 *
 * 路径任一段不存在或不能继续下钻就返回 undefined（不 throw）。
 */
export function extractByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (path.length === 0) return obj;

  // tokenize: 把 'a.b[0].c' 拆成 ['a', 'b', '0', 'c']
  const tokens = tokenizePath(path);
  if (tokens === null) return undefined;

  let current: unknown = obj;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object' && typeof current !== 'function') return undefined;
    // array index 走数组 access；普通字段走 object property
    // Array.isArray + 数字 token：用数字索引
    const indexedAsArray =
      Array.isArray(current) && /^\d+$/.test(token) ? Number(token) : null;
    if (indexedAsArray !== null) {
      current = (current as unknown[])[indexedAsArray];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

/** 路径 tokenizer — 出错（如未闭合的 [）返回 null */
function tokenizePath(path: string): string[] | null {
  const tokens: string[] = [];
  let buf = '';
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      if (buf.length > 0) tokens.push(buf);
      buf = '';
      i++;
      continue;
    }
    if (ch === '[') {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = '';
      }
      const close = path.indexOf(']', i + 1);
      if (close === -1) return null; // malformed
      const inner = path.slice(i + 1, close);
      if (inner.length === 0) return null;
      tokens.push(inner);
      i = close + 1;
      // 允许 [0].foo 或 [0][1] 之间没显式 '.'
      if (i < path.length && path[i] === '.') i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

// ---------------------------------------------------------------------------
// Predicate interpreter
// ---------------------------------------------------------------------------

/**
 * 评估 PredicateExpr — 返回布尔。
 *
 * 语义:
 * - eq:        after path === value
 * - increase:  Number(after path) > Number(before path)，两个都得是有限数
 * - decrease:  Number(after path) < Number(before path)
 * - change:    !Object.is(before path, after path)
 * - truthy:    Boolean(after path) === true
 * - falsy:     Boolean(after path) === false
 * - matches:   String(after path) regex 匹配
 * - and / or:  对 clauses 递归
 *
 * before 可选（eq/truthy/falsy/matches 不需要 before）；不传 before 时按 {} 处理。
 */
export function evaluatePredicate(
  expr: PredicateExpr,
  before: Snapshot | undefined,
  after: Snapshot,
): boolean {
  return evaluatePredicateInner(expr, before ?? {}, after).passed;
}

/**
 * 评估 + 给出失败 reason — 用于错误信息友好化。
 *
 * reason 在 passed=true 时是 'predicate satisfied'，
 * 失败时是 "{op} on {path}: {actual=...} (expected ...)" 这种结构化句子。
 */
export function evaluatePredicateWithReason(
  expr: PredicateExpr,
  before: Snapshot | undefined,
  after: Snapshot,
): { passed: boolean; reason: string } {
  return evaluatePredicateInner(expr, before ?? {}, after);
}

function evaluatePredicateInner(
  expr: PredicateExpr,
  before: Snapshot,
  after: Snapshot,
): { passed: boolean; reason: string } {
  switch (expr.op) {
    case 'eq': {
      const actual = extractByPath(after, expr.path);
      const passed = actual === expr.value;
      return {
        passed,
        reason: passed
          ? `eq: ${expr.path} === ${formatValue(expr.value)}`
          : `eq failed: ${expr.path} = ${formatValue(actual)}, expected ${formatValue(expr.value)}`,
      };
    }
    case 'increase': {
      const a = toFiniteNumber(extractByPath(before, expr.path));
      const b = toFiniteNumber(extractByPath(after, expr.path));
      if (a === null || b === null) {
        return {
          passed: false,
          reason: `increase failed: ${expr.path} not a finite number (before=${formatValue(extractByPath(before, expr.path))}, after=${formatValue(extractByPath(after, expr.path))})`,
        };
      }
      const passed = b > a;
      return {
        passed,
        reason: passed
          ? `increase: ${expr.path} ${a} → ${b}`
          : `increase failed: ${expr.path} ${a} → ${b} (no increase)`,
      };
    }
    case 'decrease': {
      const a = toFiniteNumber(extractByPath(before, expr.path));
      const b = toFiniteNumber(extractByPath(after, expr.path));
      if (a === null || b === null) {
        return {
          passed: false,
          reason: `decrease failed: ${expr.path} not a finite number (before=${formatValue(extractByPath(before, expr.path))}, after=${formatValue(extractByPath(after, expr.path))})`,
        };
      }
      const passed = b < a;
      return {
        passed,
        reason: passed
          ? `decrease: ${expr.path} ${a} → ${b}`
          : `decrease failed: ${expr.path} ${a} → ${b} (no decrease)`,
      };
    }
    case 'change': {
      const a = extractByPath(before, expr.path);
      const b = extractByPath(after, expr.path);
      const passed = !Object.is(a, b);
      return {
        passed,
        reason: passed
          ? `change: ${expr.path} ${formatValue(a)} → ${formatValue(b)}`
          : `change failed: ${expr.path} stayed at ${formatValue(a)}`,
      };
    }
    case 'truthy': {
      const v = extractByPath(after, expr.path);
      const passed = Boolean(v);
      return {
        passed,
        reason: passed
          ? `truthy: ${expr.path} = ${formatValue(v)}`
          : `truthy failed: ${expr.path} = ${formatValue(v)}`,
      };
    }
    case 'falsy': {
      const v = extractByPath(after, expr.path);
      const passed = !v;
      return {
        passed,
        reason: passed
          ? `falsy: ${expr.path} = ${formatValue(v)}`
          : `falsy failed: ${expr.path} = ${formatValue(v)}`,
      };
    }
    case 'matches': {
      const v = extractByPath(after, expr.path);
      if (typeof v !== 'string') {
        return {
          passed: false,
          reason: `matches failed: ${expr.path} not a string (${formatValue(v)})`,
        };
      }
      let re: RegExp;
      try {
        re = new RegExp(expr.pattern);
      } catch (e) {
        return {
          passed: false,
          reason: `matches failed: invalid regex /${expr.pattern}/ (${(e as Error).message})`,
        };
      }
      const passed = re.test(v);
      return {
        passed,
        reason: passed
          ? `matches: ${expr.path} matches /${expr.pattern}/`
          : `matches failed: ${expr.path} = ${formatValue(v)}, no match for /${expr.pattern}/`,
      };
    }
    case 'and': {
      const reasons: string[] = [];
      for (const clause of expr.clauses) {
        const r = evaluatePredicateInner(clause, before, after);
        if (!r.passed) {
          return {
            passed: false,
            reason: `and failed: ${r.reason}`,
          };
        }
        reasons.push(r.reason);
      }
      return { passed: true, reason: `and: ${reasons.join(' && ')}` };
    }
    case 'or': {
      const reasons: string[] = [];
      for (const clause of expr.clauses) {
        const r = evaluatePredicateInner(clause, before, after);
        if (r.passed) {
          return { passed: true, reason: `or: ${r.reason}` };
        }
        reasons.push(r.reason);
      }
      return {
        passed: false,
        reason: `or failed: all clauses missed (${reasons.join(' | ')})`,
      };
    }
    default: {
      // 类型穷尽检查 — 编译期保护
      const _exhaustive: never = expr;
      return { passed: false, reason: `unknown predicate op: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}
