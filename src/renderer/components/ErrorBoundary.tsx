// ============================================================================
// ErrorBoundary - 全局错误边界组件
// 捕获 React 渲染错误，防止整个应用崩溃
// ============================================================================

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

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

    // 可选：发送到错误追踪服务
    // TODO: 集成 Sentry 或其他错误追踪服务
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

      // 默认的错误 UI
      return (
        <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-100">
          <div className="text-center p-8 max-w-md">
            {/* 错误图标 */}
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>
            </div>

            {/* 错误标题 */}
            <h1 className="text-xl font-bold mb-2">出错了</h1>
            <p className="text-zinc-400 mb-6">
              应用遇到了一个意外错误，请尝试重试或刷新页面。
            </p>

            {/* 错误详情（折叠显示） */}
            {this.state.error && (
              <details className="mb-6 text-left">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-400 text-sm">
                  查看错误详情
                </summary>
                <div className="mt-2 p-3 bg-zinc-800 rounded-lg text-xs font-mono text-red-300 overflow-auto max-h-32">
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
              <button
                onClick={this.handleRetry}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                重试
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-zinc-700 rounded-lg hover:bg-zinc-600 transition-colors"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
