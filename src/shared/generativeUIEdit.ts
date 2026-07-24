// ============================================================================
// Generative UI 人工编辑 —— fence 定位、对账哈希、编辑标记（host / renderer 共用）
// ============================================================================
//
// 产物没有独立存储，消息正文里的 ```generative_ui fence 就是唯一真源
// （extractArtifacts 每次读都当场重算）。所以「把用户的修改存下来」= 把某条消息里
// 第 N 个 fence 的正文换掉。这个模块只做定位、对账、标记三件纯逻辑，两端共用一份，
// 避免 host 和 renderer 各写一套正则算出不同的 ordinal。

/** 与渲染路径一致：MessageContent 只把 ```generative_ui 交给可编辑的 GenerativeUIBlock。 */
function fenceRegex(): RegExp {
  return /```generative_ui\s*\n([\s\S]*?)```/g;
}

/** 编辑标记：跟着内容走，天然穿透压缩 / 导出 / 云同步。放正文末尾——放开头会顶到
 *  <!DOCTYPE> 前面触发 quirks mode，末尾注释永远安全。 */
const EDIT_MARKER_RE = /\n?<!--\s*neo:user-edited[^>]*-->/g;

/** djb2；两端必须算出同一个值，别换实现。对账用，不用抗碰撞。 */
export function hashGenerativeUiBody(body: string): string {
  const normalized = body.trim();
  let hash = 5381;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

/** 取第 N 个 fence 的正文（含标记，如果有）；越界返回 null。 */
export function extractGenerativeUiFenceBody(content: string, ordinal: number): string | null {
  const regex = fenceRegex();
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(content)) !== null) {
    if (index === ordinal) return match[1];
    index += 1;
  }
  return null;
}

/** 某个 Markdown 源偏移处的 fence 是第几个（与 neoUIOrdinalAtOffset 同构）。 */
export function generativeUiOrdinalAtOffset(content: string, offset?: number): number {
  if (typeof offset !== 'number') return 0;
  const matches = [...content.matchAll(/```generative_ui\s*\n/g)];
  let ordinal = 0;
  for (let index = 0; index < matches.length; index += 1) {
    if ((matches[index].index ?? Number.MAX_SAFE_INTEGER) > offset) break;
    ordinal = index;
  }
  return ordinal;
}

/** 去掉任意位置的旧编辑标记——round-trip 可能把它挪走，全局清再重贴，不让它堆叠。 */
export function stripEditMarker(body: string): string {
  return body.replace(EDIT_MARKER_RE, '');
}

export function hasEditMarker(body: string): boolean {
  EDIT_MARKER_RE.lastIndex = 0;
  return EDIT_MARKER_RE.test(body);
}

/**
 * 给正文贴一条新鲜的编辑标记（先清旧的）。dateIso 由调用方传（host 用当天日期），
 * 保持本函数纯粹、可测。fields 是这次动过的属性，仅供模型参考。
 */
export function applyEditMarker(body: string, dateIso: string, fields: readonly string[]): string {
  const stripped = stripEditMarker(body).replace(/\s+$/, '');
  const fieldsPart = fields.length > 0 ? ` fields=${fields.join(',')}` : '';
  return `${stripped}\n<!-- neo:user-edited ${dateIso}${fieldsPart} -->`;
}

export type FenceReplaceResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'ordinal_out_of_range' };

/** 把第 N 个 fence 的正文整段换掉，其余字节不碰。 */
export function replaceGenerativeUiFence(
  content: string,
  ordinal: number,
  newBody: string,
): FenceReplaceResult {
  const regex = fenceRegex();
  let index = 0;
  let replaced = false;
  const next = content.replace(regex, (whole: string) => {
    if (index++ !== ordinal) return whole;
    replaced = true;
    // 保住原 fence 的开合语法，只换中间正文
    const open = whole.slice(0, whole.indexOf('\n') + 1);
    return `${open}${newBody}\n\`\`\``;
  });
  return replaced ? { ok: true, content: next } : { ok: false, reason: 'ordinal_out_of_range' };
}
