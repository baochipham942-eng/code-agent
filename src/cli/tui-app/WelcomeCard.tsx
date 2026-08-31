// ============================================================================
// 首屏欢迎海报（Grok Build 构图）：全屏留白里居中一张宽卡——
// 大星簇 logo + 产品名/版本 + 高亮句 + 快捷动作表。
// 矮终端退回 3 行紧缩 logo，避免把输入区顶出屏。
// ============================================================================

import { Box, Text } from 'ink';
import {
  NEO_LOGO_COMPACT,
  NEO_LOGO_FULL,
  WELCOME_ACTIONS,
  WELCOME_HEADLINE,
  WELCOME_SUBHEAD,
} from './welcomeSplash';

export function WelcomeCard({ version, columns, compact, selectedIndex = 0 }: {
  version: string;
  columns: number;
  compact?: boolean;
  /** 当前高亮的动作（键盘/鼠标）；-1 = 不高亮 */
  selectedIndex?: number;
}) {
  const logo = compact ? NEO_LOGO_COMPACT : NEO_LOGO_FULL;
  const cardWidth = Math.min(Math.max(columns - 8, 42), 78);
  const contentWidth = Math.max(28, cardWidth - 28);

  return (
    <Box
      width={cardWidth}
      borderStyle="round"
      borderColor="gray"
      paddingX={3}
      paddingY={compact ? 0 : 1}
      columnGap={3}
    >
      <Box flexDirection="column">
        {logo.map((line, index) => (
          <Text key={index} color="cyan">{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column" width={contentWidth}>
        <Text>
          <Text bold>Agent Neo</Text>
          {version ? <Text dimColor>  {version}</Text> : null}
        </Text>
        {compact ? null : <Box height={1} />}
        <Text color="yellow" bold>{WELCOME_HEADLINE}</Text>
        <Text dimColor>{WELCOME_SUBHEAD}</Text>
        {compact ? null : <Box height={1} />}
        {WELCOME_ACTIONS.map((action, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={action.id} width={contentWidth} justifyContent="space-between">
              <Text inverse={selected} color={selected ? 'cyan' : undefined}>{action.label}</Text>
              <Text dimColor={!selected} inverse={selected} color={selected ? 'cyan' : undefined}>
                {action.shortcut}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
