// Transcript 导出 metadata 保留回归测试（Codex audit #309 LOW1）。
// 背景：DB 读回路径已保留 message metadata（turnQuality 徽标数据），但导出链两跳
// （CLI export mapper / JSON 导出 mapper）仍然丢弃；另 exportTranscript 此前读
// getDefaultCache() 全局单例而非构造传入的 cache 实例，CLI export 建的 cache 实际没被用。
// 口径：JSON 导出=数据保真面带 metadata；anonymize 模式剥离（metadata 含 memory preview）。

import { describe, expect, it } from 'vitest';
import { TranscriptExporter } from '../../../src/host/session/transcriptExporter';
import { SessionLocalCache } from '../../../src/host/session/localCache';

const turnQualityMetadata = {
  turnQuality: {
    capabilities: { agentId: 'explore', agentName: 'Explorer', requestedAgentId: 'explore' },
  },
};

function seededCache(): SessionLocalCache {
  const cache = new SessionLocalCache({ maxSessions: 5 });
  cache.setSession({
    sessionId: 'sess-export-1',
    messages: [
      { id: 'u1', role: 'user', content: '问题', timestamp: 100 },
      { id: 'a1', role: 'assistant', content: '回答', timestamp: 200, metadata: turnQualityMetadata },
    ],
    startedAt: 100,
    lastActivityAt: 200,
    totalTokens: 0,
    metadata: { title: '导出测试' },
  });
  return cache;
}

describe('TranscriptExporter metadata 保留', () => {
  it('exportTranscript 使用构造传入的 cache 实例（非全局单例）', async () => {
    const exporter = new TranscriptExporter({ cache: seededCache() });
    const result = await exporter.exportTranscript('sess-export-1', { format: 'markdown' });
    expect(result.success).toBe(true);
  });

  it('JSON 导出携带 assistant 消息的 metadata.turnQuality', async () => {
    const exporter = new TranscriptExporter({ cache: seededCache() });
    const result = await exporter.exportTranscript('sess-export-1', {
      format: 'json',
      guardSensitiveData: false,
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.markdown!) as {
      messages: Array<{ role: string; metadata?: typeof turnQualityMetadata }>;
    };
    const assistant = parsed.messages.find((m) => m.role === 'assistant');
    expect(assistant?.metadata).toEqual(turnQualityMetadata);
  });

  it('anonymize 模式下 metadata 整体剥离（含 memory preview 等）', async () => {
    const exporter = new TranscriptExporter({ cache: seededCache() });
    const result = await exporter.exportTranscript('sess-export-1', {
      format: 'json',
      anonymize: true,
      guardSensitiveData: false,
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.markdown!) as {
      messages: Array<{ role: string; metadata?: unknown }>;
    };
    for (const message of parsed.messages) {
      expect(message.metadata).toBeUndefined();
    }
  });
});
