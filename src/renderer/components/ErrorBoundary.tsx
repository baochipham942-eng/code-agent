// ============================================================================
// ErrorBoundary - 全局错误边界组件
// 捕获 React 渲染错误，防止整个应用崩溃
// ============================================================================

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { captureRendererException } from '../observability/sentryRenderer';
import { languages } from '../i18n';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { Button } from './primitives/Button';

/** componentStack 整串能有上百行，落盘只留最靠近崩溃点的这几层。 */
const COMPONENT_STACK_FRAMES = 8;

export function summarizeComponentStack(
  componentStack: string | null | undefined,
  frames = COMPONENT_STACK_FRAMES,
): string {
  if (!componentStack) return '';
  return componentStack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, frames)
    .join('\n');
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.setState({ errorInfo });

    // 上报到 Sentry（无 DSN / opt-out 时为 no-op）。componentStack 入 extra 便于定位
    captureRendererException(error, {
      tags: { surface: 'renderer', source: 'error-boundary' },
      extra: { componentStack: errorInfo.componentStack ?? undefined },
    });

    // 同时落一份到后端 file logger（code-agent-*.log）：renderer logger 只走 console，
    // 正式包 devtools 又是关的，此前渲染塌陷只有 Sentry 后台一条路，真机复发时本地无据可查。
    // fire-and-forget，IPC 自身失败静默吞掉，绝不让日志再触发一次崩溃。
    const stackSummary = summarizeComponentStack(errorInfo.componentStack);
    void ipcService
      .invokeDomain(IPC_DOMAINS.DIAGNOSTICS, 'logClientError', {
        context: 'ErrorBoundary',
        message: `${error.name}: ${error.message}`,
        detail: [error.stack ?? '', stackSummary].filter(Boolean).join('\n--- componentStack ---\n'),
      })
      .catch(() => {});
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // 如果提供了自定义 fallback，使用它
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 默认的错误 UI —— class 组件不能用 hook，render 内直接读 store 语言（带 zh 兜底防错误 UI 自身崩溃）
      const t = languages[useAppStore.getState().language] ?? languages.zh;
      return (
        <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-200">
          <div className="text-center p-8 max-w-md">
            {/* 错误图标 */}
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-badge-danger" />
              </div>
            </div>

            {/* 错误标题 */}
            <h1 className="text-xl font-bold mb-2">{t.errorBoundary.title}</h1>
            <p className="text-zinc-400 mb-6">
              {t.errorBoundary.message}
            </p>

            {/* 错误详情（折叠显示） */}
            {this.state.error && (
              <details className="mb-6 text-left">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-400 text-sm">
                  {t.errorBoundary.viewDetails}
                </summary>
                <div className="mt-2 p-3 bg-zinc-700 rounded-lg text-xs font-mono text-badge-danger overflow-auto max-h-32">
                  <p className="font-semibold">{this.state.error.name}: {this.state.error.message}</p>
                  {this.state.errorInfo?.componentStack && (
                    <pre className="mt-2 text-zinc-500 whitespace-pre-wrap">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  )}
                </div>
              </details>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-3 justify-center">
              <Button onClick={this.handleRetry} leftIcon={<RefreshCw className="w-4 h-4" />}>
                {t.common.retry}
              </Button>
              <Button variant="secondary" onClick={this.handleReload}>
                {t.errorBoundary.refresh}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
