// ============================================================================
// 多行编辑器渲染组件（受控：状态在 App 的 editorRef，编辑逻辑在 editor.ts）
// 左侧 accent rail ┃ + 首行 ❯ 前缀；chip marker 渲染成 [Pasted: N lines] 徽章；
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
      nodes.push(<Text key={key++} inverse>{ch}</Text>);
      continue;
    }
    run += ch;
  }
  flush();
  if (cursorCol === line.length) {
    nodes.push(<Text key={key++} inverse> </Text>);
  }
  if (nodes.length === 0) {
    return <Text> </Text>;
  }
  return <Text wrap="wrap">{nodes}</Text>;
}

export function Editor({ state, width, maxRows = 10, active = true }: {
  state: EditorState;
  /** 编辑区可用总宽（含 rail + ❯ 前缀） */
  width: number;
  maxRows?: number;
  /** false = 非活跃（暂无此态，P4 权限卡接管键盘时用） */
  active?: boolean;
}) {
  // 首行前缀 '┃ ❯ '（4 列），续行 '┃   '（4 列），文本内宽 = width - 4
  const innerWidth = Math.max(width - 4, 8);
  const { startRow, endRow } = computeWindow(state.lines, state.cursorRow, innerWidth, maxRows);

  const rows: ReactNode[] = [];
  for (let row = startRow; row < endRow; row++) {
    const isFirst = row === 0;
    rows.push(
      <Box key={row}>
        {isFirst
          ? <Text color={ACCENT}>{'┃ '}<Text bold>❯ </Text></Text>
          : <Text color={ACCENT}>{'┃   '}</Text>}
        <LineContent
          line={state.lines[row]}
          cursorCol={active && row === state.cursorRow ? state.cursorCol : null}
          state={state}
        />
      </Box>,
    );
  }
  return <Box flexDirection="column">{rows}</Box>;
}
