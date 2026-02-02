// ============================================================================
// Export Command - 导出会话记录
// ============================================================================

import { Command } from 'commander';
import { terminalOutput } from '../output';
import { initializeCLIServices, getDatabaseService } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';

export const exportCommand = new Command('export')
  .description('导出会话记录为 Markdown/JSON')
  .argument('[sessionId]', '会话 ID（不指定则导出最近会话）')
  .option('-f, --format <format>', '导出格式: markdown | json', 'markdown')
  .option('-t, --template <template>', '模板: default | minimal | share | pr-review', 'default')
  .option('-o, --output <path>', '输出文件路径')
  .option('--summary', '包含 AI 生成的摘要')
  .option('--anonymize', '匿名化敏感信息')
  .option('--list', '列出可用会话')
  .action(async (sessionId: string | undefined, options: {
    format?: string;
    template?: string;
    output?: string;
    summary?: boolean;
    anonymize?: boolean;
    list?: boolean;
  }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;

    try {
      // 初始化服务
      await initializeCLIServices();

      const db = getDatabaseService();
      if (!db) {
        terminalOutput.error('数据库未初始化');
        process.exit(1);
      }

      // 列出会话模式
      if (options.list) {
        const sessions = db.listSessions(20);
        if (sessions.length === 0) {
          terminalOutput.info('没有找到会话记录');
          process.exit(0);
        }

        terminalOutput.info('可用会话:');
        for (const session of sessions) {
          const date = new Date(session.createdAt).toLocaleString();
          const preview = session.title || session.id.substring(0, 8);
          console.log(`  ${session.id}  ${date}  ${preview}`);
        }
        process.exit(0);
      }

      // 动态导入 TranscriptExporter（避免循环依赖）
      const { TranscriptExporter } = await import('../../main/session/transcriptExporter');
      const { SessionLocalCache } = await import('../../main/session/localCache');

      // 获取会话 ID
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const recentSessions = db.listSessions(1);
        if (recentSessions.length === 0) {
          terminalOutput.error('没有找到会话记录，请指定会话 ID');
          process.exit(1);
        }
        targetSessionId = recentSessions[0].id;
        terminalOutput.info(`使用最近会话: ${targetSessionId}`);
      }

      // 从数据库加载会话
      const session = db.getSession(targetSessionId);
      if (!session) {
        terminalOutput.error(`会话不存在: ${targetSessionId}`);
        process.exit(1);
      }

      // 获取消息
      const messages = db.getMessages(targetSessionId, 1000);

      // 转换为 CachedSession 格式
      const cache = new SessionLocalCache({ maxSessions: 10 });
      const cachedSession = {
        sessionId: session.id,
        messages: messages.map((msg, idx) => ({
          id: msg.id || `msg-${idx}`,
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
          timestamp: msg.timestamp,
        })),
        startedAt: session.createdAt,
        lastActivityAt: session.updatedAt,
        totalTokens: 0,
        metadata: { title: session.title },
      };
      cache.setSession(cachedSession);

      // 创建导出器
      const exporter = new TranscriptExporter({ cache });

      // 导出选项
      const exportOptions = {
        format: (options.format || 'markdown') as 'markdown' | 'json',
        template: (options.template || 'default') as 'default' | 'minimal' | 'share' | 'pr-review',
        prependSummary: options.summary || false,
        anonymize: options.anonymize || false,
        title: session.title || `Session ${targetSessionId.substring(0, 8)}`,
      };

      terminalOutput.startThinking('正在导出...');

      // 执行导出
      if (options.output) {
        const result = await exporter.exportTranscriptToFile(
          targetSessionId,
          options.output,
          exportOptions
        );

        if (result.success) {
          terminalOutput.stopThinking();
          terminalOutput.success(`已导出到: ${result.filePath}`);
          if (result.summary) {
            terminalOutput.info(`摘要: ${result.summary}`);
          }
          terminalOutput.info(`统计: ${result.stats?.messageCount} 条消息, ${result.stats?.characterCount} 字符`);
        } else {
          terminalOutput.stopThinking();
          terminalOutput.error(`导出失败: ${result.error}`);
          process.exit(1);
        }
      } else {
        // 输出到 stdout
        const result = await exporter.exportTranscript(targetSessionId, exportOptions);

        terminalOutput.stopThinking();

        if (result.success && result.markdown) {
          console.log(result.markdown);
        } else {
          terminalOutput.error(`导出失败: ${result.error}`);
          process.exit(1);
        }
      }

      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminalOutput.error(message);
      process.exit(1);
    }
  });
