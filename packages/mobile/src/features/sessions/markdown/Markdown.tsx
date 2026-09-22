import { Fragment, useState, type ReactNode } from 'react';

/**
 * 助手正文的 Markdown（N-MOBILE-MARKDOWN-RENDER，爸 09-17 拍板 ④A，范围见 design.md §11）。
 *
 * 只覆盖设计稿那张渲染范围表，不是 CommonMark 实现：没有 setext 标题、HTML 块、引用式链接、裸 URL 自动成链。
 * 不引 react-markdown：mobile 独立打包，根 node_modules 在原生构建机上不存在，且根 React 与 mobile 版本不同。
 * 一切正文都作为 React 文本节点输出（React 自己转义），不用 dangerouslySetInnerHTML——原始 HTML 因此只会是文本。
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

type Item = { text: string; children: { ordered: boolean; items: string[] } | null };

// 不用后行断言：iOS 16.4 以前的 WebKit 不认，整个包会在解析期抛错。
const cells = (line: string) => line.replace(/\\\|/g, '\u0000').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim().replaceAll('\u0000', '|'));
const isTableStart = (lines: string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_DELIMITER.test(lines[i + 1]);
// 有序项只有从 1 起才打断段落：「1.5 倍速」下一行的「2026. 年」还是正文。
const startsBlock = (lines: string[], i: number) => !lines[i].trim() || FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i])
  || QUOTE.test(lines[i]) || /^(?:[-*+]|1[.)])$/.test(ITEM.exec(lines[i])?.[2] ?? '') || isTableStart(lines, i);

function CodeBlock({ code, copyLabel, copiedLabel }: { code: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="md-code">
    <button type="button" className="md-copy" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}>{copied ? copiedLabel : copyLabel}</button>
    <pre><code>{code}</code></pre>
  </div>;
}

export function Markdown({ source, copyLabel, copiedLabel }: { source: string; copyLabel: string; copiedLabel: string }) {
  return <>{blocks(source.replace(/\r\n?/g, '\n').split('\n'), { copyLabel, copiedLabel })}</>;
}

function blocks(lines: string[], labels: { copyLabel: string; copiedLabel: string }): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = out.length;
    const fence = FENCE.exec(line);
    if (!line.trim()) { i++; continue; }
    if (fence) {
      const marker = fence[1];
      const close = lines.findIndex((l, j) => j > i && new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(l));
      // 流式里围栏还没闭合：剩下的原样当文本放着，闭合后再变成代码块——不先按 Markdown 解析里面的 # 和 *，免得闭合那一下整段跳版。
      if (close < 0) { out.push(<p key={key}>{lines.slice(i).join('\n')}</p>); break; }
      out.push(<CodeBlock key={key} code={lines.slice(i + 1, close).join('\n')} {...labels} />);
      i = close + 1;
    } else if (HEADING.test(line)) {
      // 标题降级成加粗段落、字号不放大：对话里放大标题像网页。
      out.push(<p key={key} className="md-h"><strong>{inline(HEADING.exec(line)![1] ?? '')}</strong></p>);
      i++;
    } else if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(QUOTE.exec(lines[i])![1]);
      out.push(<blockquote key={key}>{blocks(quoted, labels)}</blockquote>);
    } else if (ITEM.test(line)) {
      const first = ITEM.exec(line)!;
      const base = first[1].length;
      const ordered = /\d/.test(first[2]);
      const items: Item[] = [];
      for (; i < lines.length; i++) {
        const item = ITEM.exec(lines[i]);
        if (item) {
          // 嵌套最多两层：比第一层多缩进 2 格起都算第二层，更深的也按第二层画。
          if (item[1].length >= base + 2 && items.length) {
            const parent = items.at(-1)!;
            parent.children ??= { ordered: /\d/.test(item[2]), items: [] };
            parent.children.items.push(item[3]);
          } else if (/\d/.test(item[2]) !== ordered) break;
          else items.push({ text: item[3], children: null });
        } else if (lines[i].trim() && !startsBlock(lines, i)) {
          // 懒续行：没有列表记号的非空行接在上一项后面。
          const parent = items.at(-1)!;
          if (parent.children) parent.children.items[parent.children.items.length - 1] += `\n${lines[i].trim()}`;
          else parent.text += `\n${lines[i].trim()}`;
        } else if (!lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) continue;
        else break;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={key} start={ordered && Number(first[2].slice(0, -1)) !== 1 ? Number(first[2].slice(0, -1)) : undefined}>
        {items.map((item, n) => { const Sub = item.children?.ordered ? 'ol' : 'ul'; return <li key={n}>{inline(item.text)}
          {item.children && <Sub>{item.children.items.map((text, m) => <li key={m}>{inline(text)}</li>)}</Sub>}</li>; })}
      </List>);
    } else if (isTableStart(lines, i)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      out.push(<div key={key} className="md-table" data-testid="md-table"><table>
        <thead><tr>{head.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, n) => <td key={n}>{inline(row[n] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>);
    } else {
      const paragraph: string[] = [];
      for (; i < lines.length && (paragraph.length === 0 || !startsBlock(lines, i)); i++) paragraph.push(lines[i]);
      out.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
    }
  }
  return out;
}

/**
 * 从 from 起找能闭合 delim 的位置：整串同字符前面不是空白（且不在开头那串里）；落在一串里时取这串末尾（`***x***` 的 `**` 闭在最后两个）。
 * 单字符的 `*`/`_` 跳过恰好两个的串，那是加粗的记号（`*a **b** c*`）。
 */
function closing(text: string, delim: string, from: number): number {
  for (let at = text.indexOf(delim, from); at >= 0; at = text.indexOf(delim, at + 1)) {
    let start = at;
    while (start > from && text[start - 1] === delim[0]) start--;
    let end = at + delim.length;
    while (text[end] === delim[0]) end++;
    at = end - 1;
    if (start <= from || /\s/.test(text[start - 1]) || (delim.length === 1 && end - start === 2) || (delim.length === 2 && end - start === 1)) continue;
    const close = end - delim.length;
    if (delim[0] === '_' && /\w/.test(text[end] ?? '')) continue;
    return close;
  }
  return -1;
}

function link(label: ReactNode, href: string, key: number): ReactNode {
  // 只放行 http(s)/mailto/tel：javascript: 之类不生成链接节点，只留文字。系统浏览器由 Capacitor 接 target=_blank 打开。
  return SAFE_HREF.test(href) ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <Fragment key={key}>{label}</Fragment>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  const push = (node: ReactNode) => { flush(); out.push(node); };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '\\' && /[!-/:-@[-`{-~]/.test(text[i + 1] ?? '')) { plain += text[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let run = 1; while (text[i + run] === '`') run++;
      const close = text.indexOf('`'.repeat(run), i + run);
      if (close > i + run && text[close + run] !== '`') { push(<code key={i}>{text.slice(i + run, close).trim()}</code>); i = close + run; continue; }
      plain += '`'.repeat(run); i += run; continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const image = ch === '!';
      const start = i + (image ? 2 : 1);
      const match = /^((?:[^\]\\]|\\.)*)\]\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(start));
      if (match) {
        // 图片不内联加载外部资源（隐私与流量），降级成链接，文字取 alt，没有 alt 显示地址。
        push(link(image ? (match[1] || match[2]) : inline(match[1]), match[2], i));
        i = start + match[0].length; continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) { push(link(auto[1], auto[1], i)); i += auto[0].length; continue; }
    }
    const delim = text.startsWith('**', i) ? '**' : text.startsWith('__', i) ? '__' : text.startsWith('~~', i) ? '~~' : ch === '*' || ch === '_' ? ch : '';
    if (delim && text[i + delim.length] && !/\s/.test(text[i + delim.length]) && !(delim[0] === '_' && /\w/.test(text[i - 1] ?? ''))) {
      const close = closing(text, delim, i + delim.length);
      if (close >= 0) {
        const inner = inline(text.slice(i + delim.length, close));
        push(delim === '~~' ? <del key={i}>{inner}</del> : delim.length === 2 ? <strong key={i}>{inner}</strong> : <em key={i}>{inner}</em>);
        i = close + delim.length; continue;
      }
    }
    // 没闭合的 ** / ` 在流里就是文本，等闭合那一刻再渲染。
    plain += delim || ch; i += delim.length || 1;
  }
  flush();
  return out;
}
