// ============================================================================
// scriptValidator —— 主线程侧输入加固（P2-A）
//
// 在把模型生成的脚本 / schema 送进 worker 之前做 fail-fast，替代「裸 eval 整个 body 才在
// worker 里炸」的不透明失败：
//   - validateScript：体积上限 + acorn 语法校验。worker 用 new AsyncFunction(...params, body)
//     执行脚本，故按「async 函数体」形态解析（return / 顶层 await 合法，import / export 非法），
//     与运行时行为一致。语法错带 acorn 的行列信息回报。
//   - validateForcedSchema：模型脚本给的 agent({schema}) 会被直传 forced tool_choice 的
//     inputSchema。这里要求它是「对象型且带 properties 的 JSON Schema」，堵住把任意值塞进
//     工具参数 schema 的 deferred 审计点（agentBridge.runForcedStructured 原本零校验）。
// ============================================================================

import { parse } from 'acorn';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import { WORKER_SCRIPT_PARAMS } from './sandbox';

export type ValidationResult = { ok: true } | { ok: false; error: string };

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** 递归查 AST 里是否出现某些节点类型（用于堵 import() 动态导入）。 */
function hasNodeType(node: unknown, types: Set<string>): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (typeof n.type === 'string' && types.has(n.type)) return true;
  for (const key of Object.keys(n)) {
    if (key === 'type') continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const item of v) if (hasNodeType(item, types)) return true;
    } else if (v && typeof v === 'object') {
      if (hasNodeType(v, types)) return true;
    }
  }
  return false;
}

/** 校验模型脚本可被 worker 安全解析执行（不真执行，只编译/解析）。 */
export function validateScript(script: string): ValidationResult {
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > SCRIPT_RUNTIME.MAX_SCRIPT_BYTES) {
    return { ok: false, error: `脚本体积 ${bytes} 字节超过上限 ${SCRIPT_RUNTIME.MAX_SCRIPT_BYTES} 字节` };
  }

  // 编译式校验（不执行）：用与 worker 逐字一致的形参表构造 AsyncFunction，捕获语法错 /
  // import-export 语句 / 与原语形参重名的词法声明（Codex MED#4：包成无参函数体解析会漏这类）。
  try {
    new AsyncFunctionCtor(...WORKER_SCRIPT_PARAMS, script);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `脚本语法错误: ${msg}` };
  }

  // 动态 import() 是 ImportExpression（AsyncFunction 不拦），能绕过 require/process 的 shadow
  // 拿到 node:fs / node:child_process（Codex HIGH#3）。AST 走查显式拒绝。
  try {
    const ast = parse(script, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
    if (hasNodeType(ast, new Set(['ImportExpression']))) {
      return { ok: false, error: '脚本禁止使用动态 import()（沙箱不提供模块加载）' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `脚本解析失败: ${msg}` };
  }

  return { ok: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 计算 schema 嵌套深度（对象/数组逐层下钻），用于 depth 上限。 */
function schemaDepth(node: unknown, seen: WeakSet<object>): number {
  if (!node || typeof node !== 'object') return 0;
  if (seen.has(node as object)) return Infinity; // 循环引用 → 视为无限深，拒绝
  seen.add(node as object);
  let max = 0;
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === 'object') max = Math.max(max, schemaDepth(v, seen));
  }
  return max + 1;
}

/** 递归判断对象里任意键名是否命中黑名单（如 $ref）。 */
function hasKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((x) => hasKey(x, key));
  const obj = node as Record<string, unknown>;
  if (key in obj) return true;
  return Object.values(obj).some((v) => hasKey(v, key));
}

/** 校验模型给的 schema 是可直传 forced tool_choice inputSchema 的对象型 JSON Schema，且有界。 */
export function validateForcedSchema(schema: unknown): ValidationResult {
  if (!isPlainObject(schema)) {
    return { ok: false, error: 'schema 必须是对象' };
  }
  if (schema.type !== 'object') {
    return { ok: false, error: "schema.type 必须为 'object'（forced 工具参数是对象）" };
  }
  if (!isPlainObject(schema.properties) || Object.keys(schema.properties).length === 0) {
    return { ok: false, error: 'schema.properties 必须是至少含一个字段的对象' };
  }
  // 有界化（Codex MED#5）：超大/超深/$ref/循环 → DoS / postMessage clone / provider 请求炸弹。
  // 顺序很重要（Codex R2 MED#3）：先 JSON.stringify 拦循环引用——它是唯一不依赖手写遍历就能
  // 安全检出 cycle 的防线。放在 $ref/depth 这些手写递归之前，避免循环 schema 先在递归里爆栈。
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  } catch {
    return { ok: false, error: 'schema 无法序列化（可能含循环引用）' };
  }
  if (bytes > SCRIPT_RUNTIME.MAX_SCHEMA_BYTES) {
    return { ok: false, error: `schema 过大（${bytes} 字节 > 上限 ${SCRIPT_RUNTIME.MAX_SCHEMA_BYTES}）` };
  }
  // 走到这里 schema 已确认无循环（stringify 成功），手写递归安全。
  if (hasKey(schema, '$ref')) {
    return { ok: false, error: 'schema 禁止使用 $ref（forced 工具参数须自包含）' };
  }
  if (schemaDepth(schema, new WeakSet()) > SCRIPT_RUNTIME.MAX_SCHEMA_DEPTH) {
    return { ok: false, error: `schema 嵌套过深（> ${SCRIPT_RUNTIME.MAX_SCHEMA_DEPTH} 层）` };
  }
  return { ok: true };
}
