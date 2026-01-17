// ============================================================================
// PermissionModal - Display permission requests from tools
// ============================================================================

import React from 'react';
import { X, Shield, FileEdit, FolderOpen, Terminal, Globe, AlertTriangle } from 'lucide-react';
import type { PermissionRequest } from '@shared/types';

interface Props {
  request: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}

const typeConfig: Record<string, {
  icon: React.ReactNode;
  title: string;
  color: string;
  bgColor: string;
}> = {
  file_read: {
    icon: <FolderOpen className="w-5 h-5" />,
    title: '读取文件',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
  },
  file_write: {
    icon: <FileEdit className="w-5 h-5" />,
    title: '创建/写入文件',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
  },
  file_edit: {
    icon: <FileEdit className="w-5 h-5" />,
    title: '编辑文件',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
  },
  command: {
    icon: <Terminal className="w-5 h-5" />,
    title: '执行命令',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
  },
  dangerous_command: {
    icon: <AlertTriangle className="w-5 h-5" />,
    title: '危险命令',
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
  },
  network: {
    icon: <Globe className="w-5 h-5" />,
    title: '网络请求',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
  },
};

export const PermissionModal: React.FC<Props> = ({ request, onAllow, onDeny }) => {
  const config = typeConfig[request.type] || typeConfig.command;
  const isDangerous = request.type === 'dangerous_command';

  const renderDetails = () => {
    const { details } = request;

    switch (request.type) {
      case 'file_read':
      case 'file_write':
        return (
          <div className="space-y-2">
            {details.path && <DetailRow label="路径" value={details.path} />}
          </div>
        );

      case 'file_edit':
        return (
          <div className="space-y-2">
            {details.path && <DetailRow label="路径" value={details.path} />}
            {details.changes && (
              <div className="space-y-1">
                <span className="text-xs text-zinc-500">变更内容:</span>
                <pre className="text-xs text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/20 overflow-x-auto max-h-32">
                  {details.changes.slice(0, 500)}
                  {details.changes.length > 500 && '...'}
                </pre>
              </div>
            )}
          </div>
        );

      case 'command':
      case 'dangerous_command':
        return (
          <div className="space-y-2">
            {details.command && (
              <div className="space-y-1">
                <span className="text-xs text-zinc-500">命令:</span>
                <pre className={`text-xs p-2 rounded border overflow-x-auto ${
                  isDangerous
                    ? 'text-red-300 bg-red-500/10 border-red-500/20'
                    : 'text-zinc-300 bg-zinc-800/50 border-zinc-700/50'
                }`}>
                  {details.command}
                </pre>
              </div>
            )}
          </div>
        );

      case 'network':
        return (
          <div className="space-y-2">
            {details.url && <DetailRow label="URL" value={details.url} />}
          </div>
        );

      default:
        return (
          <pre className="text-xs text-zinc-300 bg-zinc-800/50 p-2 rounded border border-zinc-700/50 overflow-x-auto">
            {JSON.stringify(details, null, 2)}
          </pre>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onDeny} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className={`flex items-center gap-3 px-6 py-4 border-b border-zinc-800 ${config.bgColor}`}>
          <div className={config.color}>{config.icon}</div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-zinc-100">{config.title}</h2>
            <p className="text-xs text-zinc-400">
              工具: <span className="font-mono">{request.tool}</span>
            </p>
          </div>
          <button
            onClick={onDeny}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Warning for dangerous commands */}
          {isDangerous && (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="text-sm text-red-300">
                此命令可能对系统造成不可逆的影响，请仔细确认后再执行。
              </div>
            </div>
          )}

          {/* Reason */}
          {request.reason && (
            <p className="text-sm text-zinc-300">{request.reason}</p>
          )}

          {/* Details */}
          {renderDetails()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-3">
          <button
            onClick={onDeny}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            拒绝
          </button>
          <button
            onClick={onAllow}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-2 ${
              isDangerous
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-emerald-500 text-white hover:bg-emerald-600'
            }`}
          >
            <Shield className="w-4 h-4" />
            允许
          </button>
        </div>
      </div>
    </div>
  );
};

// Helper component
const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-start gap-2">
    <span className="text-xs text-zinc-500 shrink-0">{label}:</span>
    <span className="text-xs text-zinc-300 font-mono break-all">{value}</span>
  </div>
);
