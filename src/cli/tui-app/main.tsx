/**
 * Ink chat 应用主体（薄入口之后的动态加载目标）。
 * 渲染 App，exitOnCtrlC 关闭（Ctrl+C 语义由 App 按中断分层表自行处理），
 * App 请求退出时 unmount 并 resolve，由调用方负责 cleanup/exit。
 */
import { render } from 'ink';
import type { CLIAgent } from '../adapter';
import { setStderrSinkMuted } from '../../host/services/infra/logger';
import { App, type InkChatOptions } from './App';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function startInkChat(agent: CLIAgent, options: InkChatOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    // Ink 拥有屏幕期间静音 logger 的 stderr 单行，防止日志行污染渲染/触发整屏重绘
    setStderrSinkMuted(true);
    process.stdout.write(HIDE_CURSOR);
    const instance = render(
      <App
        agent={agent}
        options={options}
        onExit={() => {
          process.stdout.write('\x1b]0;neo\x07');
          process.stdout.write(SHOW_CURSOR);
          setStderrSinkMuted(false);
          instance.unmount();
          resolve();
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
