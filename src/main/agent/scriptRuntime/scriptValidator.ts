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

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** 校验模型脚本可被 worker 安全解析执行（不真执行，只静态解析）。 */
export function validateScript(script: string): ValidationResult {
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > SCRIPT_RUNTIME.MAX_SCRIPT_BYTES) {
    return { ok: false, error: `脚本体积 ${bytes} 字节超过上限 ${SCRIPT_RUNTIME.MAX_SCRIPT_BYTES} 字节` };
  }
  try {
    // 与 worker 的 new AsyncFunction(body) 同构：包成 async 函数体解析。
    // → return / 顶层 await 合法；import / export 在函数体内是语法错，被自动拒绝。
    parse(`async function __wf(){\n${script}\n}`, { ecmaVersion: 'latest' });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `脚本语法错误: ${msg}` };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验模型给的 schema 是可直传 forced tool_choice inputSchema 的对象型 JSON Schema。 */
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
  return { ok: true };
}
