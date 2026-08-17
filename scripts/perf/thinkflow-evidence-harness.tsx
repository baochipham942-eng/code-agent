import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingDigestBanner } from '../../src/renderer/components/features/chat/ThinkingDigestBanner';
import { StreamingIndicator } from '../../src/renderer/components/features/chat/StreamingIndicator';
import '../../src/renderer/styles/global.css';

document.documentElement.dataset.theme = 'dark';

type EvidenceScenario = 'live' | 'collapsed' | 'none';

const LONG_REASONING = [
  '我先确认需求边界与现有消息投影，避免把正文和推理混在同一个可见通道。',
  '接着核对流式增量落点：reasoning delta 会持续追加到当前 assistant 节点。',
  '工具调用出现时，这一段思考结束；如果后面又有 reasoning delta，则视为新的思考段。',
  '折叠状态必须服从用户操作，本轮一旦手动展开或收起，自动逻辑就不再介入。',
  '最后验证无 reasoning delta 的模型不会创建空容器，仍显示原有等待占位。',
].join('\n\n');

function ThinkflowEvidence(): React.ReactElement {
  const scenario = new URLSearchParams(window.location.search).get('scenario') as EvidenceScenario | null;
  const now = Date.now();
  const segments = scenario === 'none' ? [] : [{
    id: 'reasoning-1',
    text: LONG_REASONING,
    startedAt: now - (scenario === 'live' ? 7_400 : 5_200),
    ...(scenario === 'collapsed' ? { estimatedEndedAt: now } : {}),
  }];

  document.body.dataset.thinkflowEvidenceReady = 'true';
  document.body.dataset.scenario = scenario ?? 'unknown';

  return (
    <main className="min-h-screen bg-zinc-950 px-12 py-10 text-zinc-100">
      <section
        className="mx-auto w-[720px] rounded-xl border border-zinc-800 bg-zinc-900/70 px-6 py-5 shadow-2xl"
        data-testid="evidence-card"
      >
        <div className="mb-4 flex items-center justify-between text-xs text-zinc-500">
          <span>Neo · reasoning stream evidence</span>
          <span>{scenario === 'none' ? 'GPT-4o · no reasoning delta' : 'DeepSeek Reasoner'}</span>
        </div>
        <div className="mb-4 rounded-lg bg-zinc-800/70 px-4 py-3 text-sm text-zinc-200">
          请检查当前实现，并给出明确结论。
        </div>
        <div className="space-y-3">
          <ThinkingDigestBanner
            segments={segments}
            activeSegmentId={scenario === 'live' ? 'reasoning-1' : null}
            hasNonThinkingContentAfterThinking={scenario === 'collapsed'}
            turnEndTime={scenario === 'collapsed' ? now : undefined}
          />
          {scenario === 'collapsed' && (
            <p className="text-sm leading-6 text-zinc-200">
              已完成核查：思考块在第一段正文出现后自动收起，正文继续正常显示。
            </p>
          )}
          {scenario === 'none' && (
            <StreamingIndicator startTime={now} waitingReason="model" />
          )}
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for thinkflow evidence harness.');
createRoot(root).render(<ThinkflowEvidence />);
