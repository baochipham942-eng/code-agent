// ============================================================================
// V2-B tweakWriter - className 字面量原地改写
// ----------------------------------------------------------------------------
// 不走 LLM 的快路径：UI 拖滑块 → 这里直接 babel parse 找到 line:column 上的
// JSXOpeningElement → 改 className 的 string/template literal → magic-string
// 替换 → 写盘 → vite HMR 触发 → bridge restore-selection → 用户看到变化。
//
// 支持的 className 形态：
//   className="..."             StringLiteral
//   className={"..."}           JSXExpressionContainer wrapping StringLiteral
//   className={`...`}           TemplateLiteral，必须 0 expressions（纯字面）
//
// 拒绝形态（返回 ok=false + reason='expression'）：
//   className={cn(...)}         CallExpression
//   className={cond ? a : b}    ConditionalExpression
//   className={isActive && '..'} LogicalExpression
//   className={dynamic}         Identifier / MemberExpression
//   className={`px-${n}`}       TemplateLiteral 含表达式
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';
import { applyMutation, type ClassMutation, type MutationResult } from './tailwindCategories';

export interface TweakLocation {
  /** 绝对路径 */
  file: string;
  /** 1-based, 跟 bridge / babel loc 一致 */
  line: number;
  /** 0-based, bridge 给的就是 0-based */
  column: number;
}

export type TweakResult =
  | {
      ok: true;
      newClassName: string;
      mutation: MutationResult;
    }
  | {
      ok: false;
      reason: 'expression' | 'no-className' | 'element-not-found' | 'parse-error' | 'noop' | 'io';
      detail?: string;
    };

interface JSXOpeningLike {
  type: 'JSXOpeningElement';
  loc?: { start: { line: number; column: number } };
  attributes?: Array<JSXAttrLike>;
}

interface JSXAttrLike {
  type: string;
  name?: { type?: string; name?: string };
  value?: ASTNode;
}

interface ASTNode {
  type: string;
  start?: number;
  end?: number;
  value?: string;
  expression?: ASTNode;
  quasis?: Array<{ value: { cooked?: string; raw: string } }>;
  expressions?: ASTNode[];
}

// ----------------------------------------------------------------------------
// 主函数
// ----------------------------------------------------------------------------

export function applyTweak(location: TweakLocation, mutation: ClassMutation): TweakResult {
  let source: string;
  try {
    source = readFileSync(location.file, 'utf-8');
  } catch (e) {
    return { ok: false, reason: 'io', detail: e instanceof Error ? e.message : String(e) };
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    });
  } catch (e) {
    return { ok: false, reason: 'parse-error', detail: e instanceof Error ? e.message : String(e) };
  }

  // 找 line:column 上的 JSXOpeningElement
  // bridge 给的 column 是 0-based，babel loc.start.column 也是 0-based
  const opening = findJSXOpeningElement(ast.program as ASTNode, location.line, location.column);
  if (!opening) {
    return { ok: false, reason: 'element-not-found' };
  }

  const attr = opening.attributes?.find(
    (a) => a.type === 'JSXAttribute' && a.name?.name === 'className',
  );
  if (!attr || !attr.value) {
    // 没有 className —— append 一个新的（用 mutation 计算第一个 class）
    return appendClassNameAttr(source, opening, mutation, location.file);
  }

  // 提取 string + 校验形态
  const extracted = extractClassString(attr.value);
  if (!extracted.ok) return { ok: false, reason: 'expression', detail: extracted.detail };

  const currentClasses = extracted.value.split(/\s+/).filter(Boolean);
  const result = applyMutation(currentClasses, mutation);
  if (!result.changed) return { ok: false, reason: 'noop' };

  const newClassString = result.finalClasses.join(' ');

  // 用 magic-string 替换 value 节点字符串部分
  const replaceRange = extracted.replaceRange;
  if (replaceRange == null) {
    return { ok: false, reason: 'parse-error', detail: 'value 节点缺 start/end' };
  }

  const ms = new MagicString(source);
  // 替换 quotes/braces 之间的纯文本部分
  ms.overwrite(replaceRange.start, replaceRange.end, newClassString);
  try {
    writeFileSync(location.file, ms.toString(), 'utf-8');
  } catch (e) {
    return { ok: false, reason: 'io', detail: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, newClassName: newClassString, mutation: result };
}

// ----------------------------------------------------------------------------
// AST helpers
// ----------------------------------------------------------------------------

function findJSXOpeningElement(node: ASTNode, line: number, column: number): JSXOpeningLike | null {
  if (!node || typeof node !== 'object') return null;
  // bridge 注入的 data-code-agent-source 用的是 JSXOpeningElement.loc.start
  // 但有的环境 bridge 拿到的可能是 JSXElement.loc，所以两个都试
  if (node.type === 'JSXOpeningElement') {
    const loc = (node as ASTNode & { loc?: { start: { line: number; column: number } } }).loc;
    if (loc && loc.start.line === line && loc.start.column === column) {
      return node as unknown as JSXOpeningLike;
    }
  }
  // 递归
  for (const key of Object.keys(node)) {
    const val = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object') {
          const found = findJSXOpeningElement(child as ASTNode, line, column);
          if (found) return found;
        }
      }
    } else if (val && typeof val === 'object') {
      const found = findJSXOpeningElement(val as ASTNode, line, column);
      if (found) return found;
    }
  }
  return null;
}

interface ExtractOk {
  ok: true;
  value: string;
  /** ms.overwrite 的字符范围（替换 quote/brace 内部） */
  replaceRange: { start: number; end: number } | null;
}
interface ExtractFail {
  ok: false;
  detail: string;
}

function extractClassString(value: ASTNode): ExtractOk | ExtractFail {
  // Case A: JSXAttribute value = StringLiteral 直接 className="..."
  if (value.type === 'StringLiteral' || value.type === 'Literal') {
    const start = (value.start ?? 0) + 1; // 跳过左 quote
    const end = (value.end ?? 0) - 1; // 不含右 quote
    return { ok: true, value: value.value || '', replaceRange: { start, end } };
  }
  // Case B: JSXExpressionContainer
  if (value.type === 'JSXExpressionContainer' && value.expression) {
    const expr = value.expression;
    if (expr.type === 'StringLiteral' || expr.type === 'Literal') {
      const start = (expr.start ?? 0) + 1;
      const end = (expr.end ?? 0) - 1;
      return { ok: true, value: expr.value || '', replaceRange: { start, end } };
    }
    if (expr.type === 'TemplateLiteral') {
      const exprList = expr.expressions || [];
      const quasis = expr.quasis || [];
      if (exprList.length > 0) {
        return { ok: false, detail: '模板字符串含动态表达式，需要走 visual_edit' };
      }
      if (quasis.length === 1) {
        const quasi = quasis[0];
        const text = quasi.value.cooked ?? quasi.value.raw;
        // template literal 的纯字面 quasi 包在 backtick 里：`...`
        const start = (expr.start ?? 0) + 1;
        const end = (expr.end ?? 0) - 1;
        return { ok: true, value: text, replaceRange: { start, end } };
      }
      return { ok: false, detail: 'template literal 结构非预期' };
    }
    return { ok: false, detail: `className 不是字面量（${expr.type}），需要走 visual_edit` };
  }
  return { ok: false, detail: `className value 形态不支持（${value.type}）` };
}

function appendClassNameAttr(
  source: string,
  opening: JSXOpeningLike,
  mutation: ClassMutation,
  file: string,
): TweakResult {
  // 没 className 时，调一次 applyMutation([], mutation) 得到第一个 class
  const result = applyMutation([], mutation);
  if (!result.changed) return { ok: false, reason: 'noop' };
  const newClassString = result.finalClasses.join(' ');

  // 在 opening tag 名字之后插入 className="..."
  // opening.loc.start 是 < 之前位置，但 attributes 之前的位置我们没直接拿
  // 简单起见：在 opening 末尾的 > 或 /> 之前插入。要拿 opening.end 但 JSXOpeningLike 没暴露
  // 这里降级返回 element-not-found，让 UI 提示「请先给元素加 className=""」
  void source;
  void file;
  void opening;
  void newClassString;
  return {
    ok: false,
    reason: 'no-className',
    detail: 'V2-B 不支持给无 className 的元素插入 className 属性，请手动加 className="" 后再 Tweak',
  };
}
