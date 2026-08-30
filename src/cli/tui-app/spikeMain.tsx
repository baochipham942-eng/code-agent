/**
 * Step 0 spike 应用主体：全屏 Box 布局——顶部消息区（含中文，验证 CJK 宽字符）
 * + 底部输入回显行 + 状态栏。非 TTY（stdin 被重定向）时渲染初始帧后自动退出，
 * 便于 `node dist/cli/spike.cjs < /dev/null` 做无头验证。
 */
import { useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';

const SEED_MESSAGES = [
  { role: 'user', text: '你好，帮我看一下 neo chat 的 TUI 重写方案' },
  { role: 'assistant', text: '好的。计划用 Ink 重写：React 组件 + Yoga 布局，中文混排 English 也不会错位。' },
  { role: 'user', text: '状态栏要显示 token 用量（输入 12,345 / 输出 678）' },
];

function InputRow() {
  const { exit } = useApp();
  const [typed, setTyped] = useState('');

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setTyped((prev) => prev.slice(0, -1));
      return;
    }
    if (key.return) {
      setTyped('');
      return;
    }
    if (input) {
      setTyped((prev) => prev + input);
    }
  });

  return (
    <Text>
      输入：{typed}
      <Text color="gray">█</Text>
    </Text>
  );
}

function SpikeApp({ interactive }: { interactive: boolean }) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        {SEED_MESSAGES.map((message, index) => (
          <Text key={index} wrap="wrap">
            <Text bold color={message.role === 'user' ? 'green' : 'magenta'}>
              {message.role === 'user' ? '你' : 'Neo'}：
            </Text>
            {message.text}
          </Text>
        ))}
      </Box>
      <Box borderStyle="single" borderColor="yellow" paddingX={1}>
        {interactive ? <InputRow /> : <Text>输入：（非 TTY，仅渲染初始帧）</Text>}
      </Box>
      <Box paddingX={1}>
        <Text backgroundColor="blue" color="white">
          {' spike 就绪 | 宽字符测试：中文Ｅｎｇｌｉｓｈ混排 | Ctrl+C 退出 '}
        </Text>
      </Box>
    </Box>
  );
}

export function start() {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const instance = render(<SpikeApp interactive={isTTY} />);

  if (!isTTY) {
    // 非交互环境：给一帧时间完成渲染后自动退出
    setTimeout(() => {
      instance.unmount();
    }, 300);
  }
}
