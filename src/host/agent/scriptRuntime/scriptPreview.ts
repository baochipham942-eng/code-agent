// ============================================================================
// scriptPreview —— 审批卡用的脚本静态预览（P3b）
//
// dynamic-workflow 跑前要给用户看「这个脚本大概会做什么」：phases（声明顺序）+ 扇出量
// 估计 + 是否动写。Neo 的脚本是 bare-body（无 export const meta，phases 来自运行时
// phase() 调用，P1 既定），故这里靠 AST 静态抽取 phase('字面量') / agent()/parallel()/
// pipeline() 调用点。best-effort：动态 phase 标题、计算式 tools 抓不到，跳过即可——预览
// 不要求精确，只为审批时给用户一个量级感知。解析失败返回空预览，绝不抛错。
// ============================================================================

import { parse } from 'acorn';

export interface ScriptPreview {
  /** phase('字面量') 标题，按源码顺序去重。 */
  phases: string[];
  /** agent( 调用点数量（含 parallel/pipeline 内嵌的）——扇出量估计。 */
  agentCallSites: number;
  /** parallel( 调用点数量。 */
  parallelCallSites: number;
  /** pipeline( 调用点数量。 */
  pipelineCallSites: number;
  /** 是否出现 agent({tools:'edit'|'full'})——动写提示（影响审批风险维度）。 */
  writeHint: boolean;
  /**
   * PTC 脚本里 `tools.<name>()` 调到的工具名（去重）。计算成员访问记 '*'（证不了是谁）。
   * 权限档由调用方按注册表解析——预览层是纯静态函数，不认识工具注册表。
   */
  toolCallNames: string[];
}

function emptyPreview(): ScriptPreview {
  return { phases: [], agentCallSites: 0, parallelCallSites: 0, pipelineCallSites: 0, writeHint: false, toolCallNames: [] };
}

function literalString(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  return undefined;
}

/**
 * 判断一次 agent() 调用是否有写风险（fail-closed，Codex R1 HIGH#2）。
 * writeHint 会喂超时授权决策，所以「静态证不了是只读」必须当成写风险，否则非字面量 tools
 * （变量/spread/整个 opts 是变量）会被误判只读 → 超时自动批准一个实际可写的 workflow = 审批绕过。
 * 判定：
 *   - 无第二参（无 opts）→ 只读（默认安全档，不误报）
 *   - opts 是对象字面量：无 tools 键 → 只读；tools 是字面量 'readonly' → 只读；
 *     tools 是 'edit'/'full' 字面量 → 写；tools 非字面量 → 写风险；含 spread → 写风险（可能注入 tools）
 *   - opts 不是对象字面量（变量/调用/...）→ 写风险（无法内省）
 */
function agentHasWriteRisk(args: unknown[]): boolean {
  if (args.length < 2 || args[1] == null) return false; // 无 opts = 默认只读档
  const opts = args[1] as Record<string, unknown>;
  if (opts.type !== 'ObjectExpression' || !Array.isArray(opts.properties)) return true; // opts 不可内省 → fail-closed
  let toolsValue: unknown | undefined;
  let toolsSeen = false;
  for (const prop of opts.properties as Array<Record<string, unknown>>) {
    if (prop.type === 'SpreadElement') return true; // spread 可能注入 tools → fail-closed
    if (prop.type !== 'Property') continue;
    // computed key（{[k]:..} / {[`tools`]:..}）静态读不出键名 → 可能就是 tools，fail-closed（Codex R2）。
    if (prop.computed === true) return true;
    const key = prop.key as Record<string, unknown> | undefined;
    const keyName = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? key.value : undefined;
    if (keyName === 'tools') { toolsValue = prop.value; toolsSeen = true; }
  }
  if (!toolsSeen) return false; // 没声明 tools = 默认只读档
  const lit = literalString(toolsValue);
  if (lit === 'readonly') return false; // 显式只读
  if (lit === 'edit' || lit === 'full') return true; // 显式写档
  return true; // 非字面量 tools（变量/计算）证不了只读 → fail-closed
}

/** 递归遍历 AST，命中 CallExpression 时收集预览信息。 */
function walk(node: unknown, acc: ScriptPreview, seenPhases: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  if (n.type === 'CallExpression') {
    const callee = n.callee as Record<string, unknown> | undefined;
    const args = Array.isArray(n.arguments) ? (n.arguments as unknown[]) : [];
    // PTC：`tools.<name>(args)` 是脚本直接碰工具的入口。审批预览必须看得见它——
    // 否则一段只用 tools.Write 的脚本 writeHint 恒 false，超时授权按「只读」自动批准。
    // 计算成员访问（tools[x]）静态证不了是哪个工具 ⇒ 记 '*'，由调用方按 fail-closed 处理。
    if (callee?.type === 'MemberExpression') {
      const object = callee.object as Record<string, unknown> | undefined;
      if (object?.type === 'Identifier' && object.name === 'tools') {
        const property = callee.property as Record<string, unknown> | undefined;
        const name = callee.computed !== true && property?.type === 'Identifier'
          ? String(property.name)
          : literalString(property) ?? '*';
        if (!acc.toolCallNames.includes(name)) acc.toolCallNames.push(name);
      }
    }
    if (callee?.type === 'Identifier') {
      switch (callee.name) {
        case 'phase': {
          const title = literalString(args[0]);
          if (title && !seenPhases.has(title)) {
            seenPhases.add(title);
            acc.phases.push(title);
          }
          break;
        }
        case 'agent':
          acc.agentCallSites++;
          if (agentHasWriteRisk(args)) acc.writeHint = true;
          break;
        case 'parallel':
          acc.parallelCallSites++;
          break;
        case 'pipeline':
          acc.pipelineCallSites++;
          break;
      }
    }
  }

  for (const key of Object.keys(n)) {
    if (key === 'type') continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const item of v) walk(item, acc, seenPhases);
    } else if (v && typeof v === 'object') {
      walk(v, acc, seenPhases);
    }
  }
}

/** 从模型脚本静态抽取审批预览。解析失败返回空预览（best-effort，不抛错）。 */
export function extractScriptPreview(script: string): ScriptPreview {
  const acc = emptyPreview();
  let ast: unknown;
  try {
    ast = parse(script, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return acc; // 预览是 best-effort，语法错不阻断（真正的 fail-fast 在 validateScript）
  }
  walk(ast, acc, new Set());
  return acc;
}
