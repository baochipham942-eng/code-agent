// PrismCodeBlock — 唯一静态 import react-syntax-highlighter(Prism) 的地方。
// messageContentParts(CodeBlock)、ToolDetails(JsonHighlight)、GenerativeUIBlock(SourceView)
// 三处此前各自静态 import 同一套重库，全部改为 React.lazy(() => import('./PrismCodeBlock'))。
// 高亮 palette 不再硬编码 oneDark，由 prismTheme 按 <html data-theme> 选择。

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { usePrismStyle } from './prismTheme';

export interface PrismCodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  wrapLongLines?: boolean;
  customStyle?: SyntaxHighlighterProps['customStyle'];
  lineNumberStyle?: SyntaxHighlighterProps['lineNumberStyle'];
  codeTagProps?: SyntaxHighlighterProps['codeTagProps'];
  className?: string;
}

const PrismCodeBlock = ({
  code,
  language,
  showLineNumbers,
  startingLineNumber,
  wrapLongLines,
  customStyle,
  lineNumberStyle,
  codeTagProps,
  className,
}: PrismCodeBlockProps) => {
  const style = usePrismStyle();
  // 高亮主题自带的 code 底色（如 oneDark 的深色块）让位给外壳卡的 var(--code-bg)，
  // 否则亮色/高对比主题下是一块不随主题的补丁；调用方显式传入的 style 仍优先。
  const mergedCodeTagProps: SyntaxHighlighterProps['codeTagProps'] = {
    ...codeTagProps,
    style: { background: 'transparent', ...codeTagProps?.style },
  };
  return (
    <SyntaxHighlighter
      className={className}
      style={style}
      language={language || 'text'}
      showLineNumbers={showLineNumbers}
      startingLineNumber={startingLineNumber}
      customStyle={customStyle}
      lineNumberStyle={lineNumberStyle}
      codeTagProps={mergedCodeTagProps}
      wrapLongLines={wrapLongLines}
    >
      {code}
    </SyntaxHighlighter>
  );
};

export default PrismCodeBlock;
