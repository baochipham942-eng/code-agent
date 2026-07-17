// PrismCodeBlock — 唯一静态 import react-syntax-highlighter(Prism)+oneDark 主题的地方。
// messageContentParts(CodeBlock)、ToolDetails(JsonHighlight)、GenerativeUIBlock(SourceView)
// 三处此前各自静态 import 同一套重库，全部改为 React.lazy(() => import('./PrismCodeBlock'))。

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';

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
  return (
    <SyntaxHighlighter
      className={className}
      style={oneDark}
      language={language || 'text'}
      showLineNumbers={showLineNumbers}
      startingLineNumber={startingLineNumber}
      customStyle={customStyle}
      lineNumberStyle={lineNumberStyle}
      codeTagProps={codeTagProps}
      wrapLongLines={wrapLongLines}
    >
      {code}
    </SyntaxHighlighter>
  );
};

export default PrismCodeBlock;
