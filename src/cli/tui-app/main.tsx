/**
 * Ink chat 应用主体（薄入口之后的动态加载目标）。
 * 渲染 App，exitOnCtrlC 关闭（Ctrl+C 语义由 App 按中断分层表自行处理），
 * App 请求退出时 unmount 并 resolve，由调用方负责 cleanup/exit。
 */
import { render } from 'ink';
import type { CLIAgent } from '../adapter';
import { App, type InkChatOptions } from './App';

export function startInkChat(agent: CLIAgent, options: InkChatOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const instance = render(
      <App
        agent={agent}
        options={options}
        onExit={() => {
          instance.unmount();
          resolve();
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
