// ============================================================================
// 首屏欢迎卡（Grok Build 风格）：全屏构图里居中渲染——
// 星簇 logo + 产品名/版本 + 实际解析的 provider/model + cwd + 快捷动作行。
// 只在空会话显示（首条消息出现即让位给消息流），取代旧的 scrollback 文字横幅。
// ============================================================================

import { Box, Text } from 'ink';

export function WelcomeCard({ version, provider, model, cwd }: {
  version: string;
  provider: string;
  model: string;
  cwd: string;
}) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={2} columnGap={2}>
      <Box flexDirection="column" justifyContent="center">
        <Text color="cyan">  ◇  </Text>
        <Text color="cyan">◇ ◈ ◇</Text>
        <Text color="cyan">  ◇  </Text>
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text bold>Agent Neo</Text>
          <Text dimColor> v{version}</Text>
        </Text>
        <Text dimColor>{provider ? `${provider}/${model}` : model}</Text>
        <Text dimColor>{cwd}</Text>
        <Text dimColor>/help · /resume · /exit · !cmd</Text>
      </Box>
    </Box>
  );
}
