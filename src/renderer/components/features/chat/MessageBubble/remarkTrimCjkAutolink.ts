// GFM 自动链接在中文正文里会把标点连同后面的字一起吞进 URL。
//
// 根因在上游：micromark-extension-gfm-autolink-literal 判断 URL 路径在哪儿收尾，用的是
// 一张**写死的半角标点 code point 表**（`,` 是 44，全角「，」是 65292，不在表里），
// 既没覆盖 Unicode 标点也没调 unicodePunctuation。域名段本来认全角，控制权一旦交给
// 路径段就失效，于是一路吃到下一个空白为止。中文句子之间不带空格，实测：
//
//   已打开 https://example.com，页面标题为 "Example Domain"。
//     → link.url = "https://example.com，页面标题为"      ← 点进去是个不存在的地址
//   （参考 https://example.com）后面  → "https://example.com）后面"
//   英文对照 https://example.com, next → "https://example.com"   ← 半角是对的
//
// 这里在 mdast 上收尾：把**自动链接**尾部的全角标点裁掉、退回正文。
// 只动自动链接——显式写的 [文字](地址) 里 URL 是作者自己给的，一个字都不能改。

import type { Plugin } from 'unified';
import type { Root, Link, Text, Parent, RootContent } from 'mdast';

/**
 * 全角标点：CJK 标点区、全角形式区、中文引号。
 *
 * 注意是**在第一个全角标点处切断**，不是裁尾部——上游一旦吞掉标点就会继续吃到下一个
 * 空白，所以坏 URL 的结尾往往是汉字而不是标点（`…example.com，页面标题为`），
 * 按 `$` 锚定裁尾根本匹配不上。
 *
 * 刻意不碰半角标点：上游对它们的成对/收尾规则是对的，再裁一刀会咬掉合法 URL
 * （维基百科那种 `/wiki/A_(b)`）。而合法 URL 里的全角字符必然是百分号编码过的，
 * 裸的全角标点出现在 URL 里，实践中只有这一个成因。
 */
const FULLWIDTH_PUNCTUATION = /[　-〿＀-￯‘’“”]/;

/** 自动链接的形状：唯一子节点是文本，且文本与 url 同源（GFM autolink literal 的产物）。 */
function isAutolinkLiteral(node: Link): boolean {
  if (node.children.length !== 1) return false;
  const [child] = node.children;
  if (child.type !== 'text') return false;
  // autolink 的显示文本要么就是 url，要么是去掉协议头的 url（GFM 对 www. 开头的写法）
  return node.url === child.value || node.url.endsWith(child.value);
}

export const remarkTrimCjkAutolink: Plugin<[], Root> = () => (tree: Root) => {
  const visit = (parent: Parent): void => {
    for (let index = 0; index < parent.children.length; index += 1) {
      const node = parent.children[index] as RootContent;
      if (node.type === 'link' && isAutolinkLiteral(node)) {
        const [child] = node.children as [Text];
        const cut = child.value.search(FULLWIDTH_PUNCTUATION);
        if (cut >= 0) {
          const kept = child.value.slice(0, cut);
          const spilled = child.value.slice(cut);
          // 切完什么都不剩说明这压根不是链接，整节点退回正文，别留个空 <a>。
          if (!kept) {
            parent.children.splice(index, 1, { type: 'text', value: child.value } as RootContent);
            continue;
          }
          child.value = kept;
          node.url = node.url.slice(0, node.url.length - spilled.length);
          // 切下来的部分原样退回正文，紧跟在链接后面——一个字符都不能丢。
          parent.children.splice(index + 1, 0, { type: 'text', value: spilled } as RootContent);
          index += 1;
        }
        continue;
      }
      if ('children' in node && Array.isArray((node as Parent).children)) {
        visit(node as Parent);
      }
    }
  };
  visit(tree);
};
