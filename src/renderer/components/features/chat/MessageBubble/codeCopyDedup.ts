// ============================================================================
// 代码块紧邻 !copy 链接去重（工单 N-CODEBLOCK-DUPCOPY）
//
// 症状：围栏代码块块头自带「复制」按钮，模型又常在块旁正文里写
// [复制命令](!copy)，react-markdown 渲染出第二个复制入口。
// 处置：渲染前在 markdown 源上删掉「紧邻围栏块」的纯 !copy 段落，只留块头入口
// （块头复制的是代码本身，比复制链接文字更接近用户意图；吸收链接文案只会把
// 「复制」改写成「复制命令」，零信息增量）。句中/正文中间的 !copy 是行内功能，
// 必须保留，因此判据收窄到「整段只有 !copy 链接 + 紧贴围栏块」。
// ============================================================================

/**
 * 「纯复制段」判据：整段（trim 后）只由一个或多个 [text](!copy) 链接与空白构成。
 * 段内还有任何其它文字（哪怕一个标点）都不算——那是句中行内用法，照常渲染。
 */
const COPY_ONLY_PARAGRAPH = /^(?:\[[^\]]*\]\(!copy\)\s*)+$/;

const HAS_COPY_LINK = /\]\(!copy\)/;

/** 是否为围栏代码块（含流式未闭合的半块）；奇数段还可能是行内 code，用 ``` 前缀区分 */
const isFenced = (segment: string): boolean => segment.startsWith('```');

/**
 * 去掉「紧邻围栏代码块」的纯 [text](!copy) 段。
 *
 * 「紧邻」判据：
 * - 段与围栏块之间只隔空白——空行算紧邻（渲染后不产生可见元素，按钮仍贴着代码块）；
 *   中间夹任何其它内容（说明文字、行内 code、列表……）就不算。
 * - 围栏块前、后的纯复制段都处理（双按钮问题同形，对称）。
 * - 所有围栏块渲染器（CodeBlock/Mermaid/Chart/GenerativeUI/Document/Spreadsheet）
 *   块头都自带复制按钮，因此不按 fence 语言区分。
 * - 代码块内部与行内 code 里的 !copy 文本原样保留（与 stripRawHtmlOutsideCode
 *   同源的切分方式，代码段永远不改动）。
 *
 * 只做删除、不新增任何用户可见文案，无 i18n 面；返回新字符串，不突变入参。
 */
export function dropCodeAdjacentCopyLinks(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i];
    if (!HAS_COPY_LINK.test(segment)) continue;
    const prevIsFence = i > 0 && isFenced(parts[i - 1]);
    const nextIsFence = i + 1 < parts.length && isFenced(parts[i + 1]);
    if (!prevIsFence && !nextIsFence) continue;

    // 空行切段（[ \t]* 容忍空行上的尾随空白）；纯换行分隔符 join 后可无损还原
    const paragraphs = segment.split(/\n[ \t]*\n/);
    const firstNonBlank = paragraphs.findIndex((p) => p.trim() !== '');
    let lastNonBlank = -1;
    for (let j = paragraphs.length - 1; j >= 0; j--) {
      if (paragraphs[j].trim() !== '') {
        lastNonBlank = j;
        break;
      }
    }
    if (prevIsFence && firstNonBlank >= 0 && COPY_ONLY_PARAGRAPH.test(paragraphs[firstNonBlank].trim())) {
      paragraphs[firstNonBlank] = '';
    }
    if (nextIsFence && lastNonBlank >= 0 && COPY_ONLY_PARAGRAPH.test(paragraphs[lastNonBlank].trim())) {
      paragraphs[lastNonBlank] = '';
    }
    parts[i] = paragraphs.join('\n\n');
  }
  return parts.join('');
}
