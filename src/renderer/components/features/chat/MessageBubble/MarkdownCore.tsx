// MarkdownCore — 唯一静态 import react-markdown 及其插件家族的地方。
// 同 mermaidLoader.ts 的设计动机：react-markdown/remark-gfm(vendor-markdown) 与
// katex/remark-math/rehype-katex(vendor-katex) 体积不小，此前被多处静态 import 钉进
// 首屏 modulepreload。所有调用方一律 React.lazy(() => import('./MarkdownCore')) 懒加载，
// 具体启用哪些插件由 props 决定（调用方不再直接 import 插件本身，避免绕开懒加载边界）。

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { Components } from 'react-markdown';

export interface MarkdownCoreProps {
  content: string;
  /** 默认开启（多数调用方需要表格/删除线等 GFM 语法），个别历史调用方需显式关闭以保持原行为 */
  gfm?: boolean;
  /** 开启后同时挂载 remarkMath + rehypeKatex，渲染 LaTeX 公式 */
  math?: boolean;
  breaks?: boolean;
  /** 额外放行的 URL scheme（如聊天内 IACT 卡片的 neo://），其余仍走 react-markdown 默认净化 */
  allowSchemes?: string[];
  components?: Components;
}

const MarkdownCore = ({
  content,
  gfm = true,
  math = false,
  breaks = false,
  allowSchemes,
  components,
}: MarkdownCoreProps) => {
  const remarkPlugins = [
    ...(gfm ? [remarkGfm] : []),
    ...(math ? [remarkMath] : []),
    ...(breaks ? [remarkBreaks] : []),
  ];
  const rehypePlugins = math ? [rehypeKatex] : [];
  const urlTransform = allowSchemes?.length
    ? (url: string) => (allowSchemes.some((scheme) => url.startsWith(scheme)) ? url : defaultUrlTransform(url))
    : undefined;

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
};

export default MarkdownCore;
