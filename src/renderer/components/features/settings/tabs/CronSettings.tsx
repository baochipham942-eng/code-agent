// ============================================================================
// CronSettings - 定时任务管理面板
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Play,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('CronSettings');

interface CronJob {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: 'success' | 'failure';
  description?: string;
  tags?: string[];
}

interface CronStats {
  totalJobs: number;
  enabledJobs: number;
  totalExecutions: number;
  lastExecution?: string;
}

export const CronSettings: React.FC = () => {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [stats, setStats] = useState<CronStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = async () => {
    try {
      const [jobsRes, statsRes] = await Promise.all([
        window.domainAPI?.invoke<CronJob[]>('cron', 'listJobs'),
        window.domainAPI?.invoke<CronStats>('cron', 'getStats'),
      ]);
      if (jobsRes?.data) setJobs(jobsRes.data);
      if (statsRes?.data) setStats(statsRes.data);
    } catch (error) {
      logger.error('Failed to load cron data', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTrigger = async (jobId: string) => {
    setTriggeringId(jobId);
    setMessage(null);
    try {
      await window.domainAPI?.invoke('cron', 'triggerJob', { jobId });
      setMessage({ type: 'success', text: '任务已触发' });
      setTimeout(() => setMessage(null), 3000);
      await loadData();
    } catch (error) {
      setMessage({ type: 'error', text: '触发失败' });
    } finally {
      setTriggeringId(null);
    }
  };

  const handleDelete = async (jobId: string) => {
    if (!confirm('确定要删除这个定时任务吗？')) return;
    setMessage(null);
    try {
      await window.domainAPI?.invoke('cron', 'deleteJob', { jobId });
      setMessage({ type: 'success', text: '任务已删除' });
      setTimeout(() => setMessage(null), 3000);
      await loadData();
    } catch (error) {
      setMessage({ type: 'error', text: '删除失败' });
    }
  };

  const formatLastRun = (lastRun?: string): string => {
    if (!lastRun) return '-';
    const date = new Date(lastRun);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    if (diffMs < 0) return '刚刚';
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}小时前`;
    return `${Math.floor(diffHour / 24)}天前`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200 mb-2">定时任务</h3>
          <p className="text-xs text-zinc-400">
            管理 HEARTBEAT.md 中定义的自动化任务。
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setIsLoading(true); loadData(); }}
          leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
        >
          刷新
        </Button>
      </div>

      {/* Job List */}
      {jobs.length === 0 ? (
        <div className="bg-zinc-800 rounded-lg p-6 text-center">
          <p className="text-sm text-zinc-400 mb-2">还没有定时任务</p>
          <p className="text-xs text-zinc-500">
            在项目 <code className="text-indigo-400">.code-agent/HEARTBEAT.md</code> 中定义任务
          </p>
        </div>
      ) : (
        <div className="border border-zinc-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-zinc-800 text-xs text-zinc-400">
                <th className="text-left px-4 py-2 font-medium">名称</th>
                <th className="text-left px-4 py-2 font-medium">Cron 表达式</th>
                <th className="text-left px-4 py-2 font-medium">状态</th>
                <th className="text-left px-4 py-2 font-medium">上次执行</th>
                <th className="text-right px-4 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-700">
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-zinc-800">
                  <td className="px-4 py-2.5">
                    <div className="text-sm text-zinc-200">{job.name}</div>
                    {job.description && (
                      <div className="text-xs text-zinc-500 mt-0.5 truncate max-w-[200px]">{job.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <code className="text-xs text-indigo-400 bg-zinc-700 px-1.5 py-0.5 rounded">{job.cron}</code>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1 text-xs ${job.enabled ? 'text-green-400' : 'text-zinc-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${job.enabled ? 'bg-green-400' : 'bg-zinc-600'}`} />
                      {job.enabled ? '启用' : '禁用'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs text-zinc-400">{formatLastRun(job.lastRun)}</span>
                    {job.lastResult === 'failure' && (
                      <AlertCircle className="inline w-3 h-3 ml-1 text-red-400" />
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleTrigger(job.id)}
                        loading={triggeringId === job.id}
                        leftIcon={<Play className="w-3 h-3" />}
                      >
                        触发
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(job.id)}
                        leftIcon={<Trash2 className="w-3 h-3 text-red-400" />}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg ${
          message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-zinc-800 rounded-lg p-3 text-center">
            <div className="text-lg font-semibold text-zinc-200">{stats.totalJobs}</div>
            <div className="text-xs text-zinc-400">总任务</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-3 text-center">
            <div className="text-lg font-semibold text-green-400">{stats.enabledJobs}</div>
            <div className="text-xs text-zinc-400">已启用</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-3 text-center">
            <div className="text-lg font-semibold text-indigo-400">{stats.totalExecutions}</div>
            <div className="text-xs text-zinc-400">总执行</div>
          </div>
        </div>
      )}

      {/* Help */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-2">使用说明</h4>
        <div className="text-xs text-zinc-400 leading-relaxed space-y-1">
          <p>编辑 <code className="text-indigo-400">.code-agent/HEARTBEAT.md</code> 添加新的定时任务。</p>
          <p>支持标准 cron 表达式，如 <code className="text-indigo-400">0 9 * * 1-5</code> (工作日 9:00)。</p>
        </div>
      </div>
    </div>
  );
};
