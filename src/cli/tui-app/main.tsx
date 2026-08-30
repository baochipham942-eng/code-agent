/**
 * Ink chat 应用主体（薄入口之后的动态加载目标）。
 * 渲染 App，exitOnCtrlC 关闭（Ctrl+C 语义由 App 按中断分层表自行处理），
 * App 请求退出时 unmount 并 resolve，由调用方负责 cleanup/exit。
 */
import { render } from 'ink';
import type { CLIAgent } from '../adapter';
import { setStderrSinkMuted } from '../../host/services/infra/logger';
import { App, type InkChatOptions } from './App';

export function startInkChat(agent: CLIAgent, options: InkChatOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    // Ink 拥有屏幕期间静音 logger 的 stderr 单行，防止日志行污染渲染/触发整屏重绘
    setStderrSinkMuted(true);
    const instance = render(
      <App
        agent={agent}
        options={options}
        onExit={() => {
          setStderrSinkMuted(false);
          instance.unmount();
          resolve();
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
