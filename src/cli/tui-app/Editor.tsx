// ============================================================================
// 多行编辑器渲染组件（受控：状态在 App 的 editorRef，编辑逻辑在 editor.ts）
// 圆角边框输入框（对标 Kimi/Grok 的 boxed input）+ 首行 ❯ 前缀；
// 空草稿显示 dim placeholder（Codex 风格，光标叠首字符）；
// chip marker 渲染成 [Pasted: N lines] 徽章；
// 高度随内容伸缩（computeWindow，上限 maxRows），光标行保持可见。
// ============================================================================

import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import {
  computeWindow,
  isChipMarker,
  type EditorState,
} from './editorState';

const ACCENT = 'green';

/** 单行内容渲染：chip marker → 徽章，光标位置 → 反色字符 */
function LineContent({ line, cursorCol, state }: {
  line: string;
  /** null = 光标不在本行 */
  cursorCol: number | null;
  state: EditorState;
}) {
  const nodes: ReactNode[] = [];
  let run = '';
  let key = 0;
  const flush = () => {
    if (run) {
      nodes.push(<Text key={key++}>{run}</Text>);
      run = '';
    }
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (isChipMarker(ch)) {
      flush();
      const chip = state.chips[ch];
      const badge = `[Pasted: ${chip?.lineCount ?? '?'} lines]`;
      nodes.push(
        cursorCol === i
          ? <Text key={key++} inverse color="cyan">{badge}</Text>
          : <Text key={key++} color="cyan">{badge}</Text>,
      );
      continue;
    }
    if (cursorCol === i) {
      flush();
      nodes.push(<Text key={key++} inverse color={ACCENT}>{ch}</Text>);
      continue;
    }
    run += ch;
  }
  flush();
  if (cursorCol === line.length) {
    nodes.push(<Text key={key++} inverse color={ACCENT}> </Text>);
  }
  if (nodes.length === 0) {
    return <Text> </Text>;
  }
  return <Text wrap="wrap">{nodes}</Text>;
}

/** 空草稿 placeholder：绿色块光标叠在首字符上，避免默认 inverse 变成白块 */
function PlaceholderLine({ text, showCursor }: { text: string; showCursor: boolean }) {
  if (!showCursor || text.length === 0) {
    return <Text dimColor>{text}</Text>;
  }
  return (
    <Text>
      <Text inverse color={ACCENT}>{text[0]}</Text>
      <Text dimColor>{text.slice(1)}</Text>
    </Text>
  );
}

export function Editor({ state, width, maxRows = 10, active = true, placeholder }: {
  state: EditorState;
  /** 编辑区可用总宽（含边框 + ❯ 前缀） */
  width: number;
  maxRows?: number;
  /** false = 非活跃（暂无此态，P4 权限卡接管键盘时用） */
  active?: boolean;
  /** 空草稿时的 dim 占位提示；不传则空草稿只显示光标 */
  placeholder?: string;
}) {
  // 边框 1 + 左 padding 1 + '❯ ' 前缀 2（右对称 2）：文本内宽 = width - 6
  const innerWidth = Math.max(width - 6, 8);
  const { startRow, endRow } = computeWindow(state.lines, state.cursorRow, innerWidth, maxRows);
  const empty = state.lines.every((line) => line.length === 0);

  const rows: ReactNode[] = [];
  for (let row = startRow; row < endRow; row++) {
    const isFirst = row === 0;
    rows.push(
      <Box key={row}>
        {isFirst
          ? <Text color={ACCENT} bold>{'❯ '}</Text>
          : <Text>{'  '}</Text>}
        {empty && isFirst && placeholder
          ? <PlaceholderLine text={placeholder} showCursor={active && state.cursorRow === 0} />
          : (
            <LineContent
              line={state.lines[row]}
              cursorCol={active && row === state.cursorRow ? state.cursorCol : null}
              state={state}
            />
          )}
      </Box>,
    );
  }
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" width={width}>
      {rows}
    </Box>
  );
}
