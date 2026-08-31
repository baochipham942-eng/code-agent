// ============================================================================
// 首屏欢迎海报（Grok Build 构图）：全屏留白里居中一张宽卡——
// 大星簇 logo + 产品名/版本 + 高亮句 + 快捷动作表。
// 矮终端退回 3 行紧缩 logo，避免把输入区顶出屏。
// ============================================================================

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  NEO_LOGO_COMPACT,
  NEO_LOGO_FULL,
  WELCOME_ACTIONS,
  WELCOME_HEADLINE,
  WELCOME_SUBHEAD,
} from './welcomeSplash';

/** 只动 logo 自己的 state，900ms 一帧，不拉整棵 App 树 */
const LOGO_TICK_MS = 900;

export function WelcomeCard({ version, columns, compact, selectedIndex = -1 }: {
  version: string;
  columns: number;
  compact?: boolean;
  /** 当前高亮的动作（键盘/鼠标悬停白底）；-1 = 不高亮 */
  selectedIndex?: number;
}) {
  const [logoTick, setLogoTick] = useState(0);
  useEffect(() => {
    if (compact) return;
    const timer = setInterval(() => setLogoTick((tick) => tick + 1), LOGO_TICK_MS);
    return () => clearInterval(timer);
  }, [compact]);
  const logo = compact ? NEO_LOGO_COMPACT : NEO_LOGO_FULL;
  const center = Math.floor(logo.length / 2);
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
          <Text
            key={index}
            color={!compact && index === center && logoTick % 2 === 1 ? 'white' : 'cyan'}
          >
            {line}
          </Text>
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
          const gap = Math.max(1, contentWidth - action.label.length - action.shortcut.length - 2);
          return (
            <Text
              key={action.id}
              backgroundColor={selected ? 'white' : undefined}
              color={selected ? 'black' : undefined}
            >
              {` ${action.label}${' '.repeat(gap)}${action.shortcut} `}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
