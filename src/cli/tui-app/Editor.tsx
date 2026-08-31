// ============================================================================
// 多行编辑器渲染组件（受控：状态在 App 的 editorRef，编辑逻辑在 editor.ts）
// 圆角边框输入框（对标 Kimi/Grok 的 boxed input）+ 首行 ❯ 前缀；
// 空草稿显示 dim placeholder；块光标在 ❯ 之后、不吃首字；
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

const CURSOR = 'green';

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
      nodes.push(<Text key={key++} inverse color={CURSOR}>{ch}</Text>);
      continue;
    }
    run += ch;
  }
  flush();
  if (cursorCol === line.length) {
    nodes.push(<Text key={key++} inverse color={CURSOR}> </Text>);
  }
  if (nodes.length === 0) {
    return <Text> </Text>;
  }
  return <Text wrap="wrap">{nodes}</Text>;
}

/** 空草稿：块光标在 ❯ 之后、placeholder 之前。用背景色格子，不用 inverse——
 *  inverse 空格紧贴 CJK 时部分终端会把「让」一起反色。 */
function PlaceholderLine({ text, showCursor }: { text: string; showCursor: boolean }) {
  return (
    <Text>
      {showCursor ? <Text backgroundColor={CURSOR} color={CURSOR}> </Text> : null}
      <Text dimColor>{text}</Text>
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
  const shellPrefix = !empty && state.lines[0].startsWith('!');

  const rows: ReactNode[] = [];
  for (let row = startRow; row < endRow; row++) {
    const isFirst = row === 0;
    rows.push(
      <Box key={row}>
        {isFirst
          ? <Text>{'❯ '}</Text>
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
    <Box borderStyle="round" borderColor={shellPrefix ? 'yellow' : 'gray'} paddingX={1} flexDirection="column" width={width}>
      {rows}
    </Box>
  );
}
