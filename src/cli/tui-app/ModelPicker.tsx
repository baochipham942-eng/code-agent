// ============================================================================
// /model 交互选择器：占据 prompt 区域的 blocking picker（键盘被它接管）
// 数据逻辑在 modelPicker.ts；这里只渲染。
// ============================================================================

import { Box, Text } from 'ink';
import type { ModelPickerItem } from './modelItems';

const MAX_VISIBLE = 12;

export function ModelPicker({ items, selected }: {
  items: ModelPickerItem[];
  selected: number;
}) {
  const start = Math.min(Math.max(selected - MAX_VISIBLE + 1, 0), Math.max(items.length - MAX_VISIBLE, 0));
  const visible = items.slice(start, start + MAX_VISIBLE);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">选择模型 provider（Enter 切换到默认模型）</Text>
      {visible.map((item, i) => {
        const isSelected = start + i === selected;
        return (
          <Text key={item.id} inverse={isSelected} dimColor={!isSelected}>
            {item.hasKey ? ' ✓ ' : ' ✗ '}
            <Text bold={isSelected}>{item.label}</Text>
            {` (${item.id})  default: ${item.defaultModel}`}
            {item.current ? ' ◄' : ''}
          </Text>
        );
      })}
      {items.length > MAX_VISIBLE ? (
        <Text dimColor>  … 共 {items.length} 个，↑↓ 翻页</Text>
      ) : null}
    </Box>
  );
}
