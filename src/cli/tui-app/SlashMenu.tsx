// ============================================================================
// Slash 补全弹窗：命令名 + 描述，↑↓ 选择（数据/过滤逻辑在 slashMenu.ts）
// ============================================================================

import { Box, Text } from 'ink';
import type { SlashItem } from './slashCommands';

const MAX_VISIBLE = 8;

export function SlashMenu({ items, selected }: { items: SlashItem[]; selected: number }) {
  if (items.length === 0) return null;
  // 选中项尽量落在可视窗内
  const start = Math.min(Math.max(selected - MAX_VISIBLE + 1, 0), Math.max(items.length - MAX_VISIBLE, 0));
  const visible = items.slice(start, start + MAX_VISIBLE);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {visible.map((item, i) => {
        const isSelected = start + i === selected;
        return (
          <Text key={item.id} inverse={isSelected} dimColor={!isSelected}>
            {'  '}/{item.name}
            {item.description ? `  ${item.description}` : ''}
          </Text>
        );
      })}
    </Box>
  );
}
