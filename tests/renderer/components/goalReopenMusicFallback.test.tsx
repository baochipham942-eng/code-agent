// @vitest-environment jsdom
// ============================================================================
// N-MEDIA-GEN-MUSIC-FALLBACK-FU1（FU1-A）：/goal 会话重开后 music_generate 的出路仍可见。
// 重开形状（历史从库加载）：assistant 消息的 toolCall 不内联 result，执行结果以
// 独立 tool 消息的 toolResults 落库；hydrateToolCallResults 回填后，折叠工具行必须
// 显示 MUSIC_SERVICE_UNAVAILABLE 的中文出路（含 {alternatives} 填充）。
// ============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

/** /goal 会话重开后的持久化消息形状（结果只在 tool 消息上，不在 assistant 的 toolCall 里）。 */
function reopenedGoalMessages(): Message[] {
  return [
    { id: 'u-1', role: 'user', content: '给这段视频配个轻快的背景音乐', timestamp: 1 },
    {
      id: 'a-1', role: 'assistant', content: '我来生成背景音乐。', timestamp: 20,
      toolCalls: [{ id: 'call-music-1', name: 'music_generate', arguments: { prompt: '轻快的背景音乐' } }],
    },
    {
      id: 'tool-1', role: 'tool', content: '', timestamp: 25,
      toolResults: [{
        toolCallId: 'call-music-1',
        success: false,
        error: 'The default MiniMax music service is unavailable (no key): do not retry.',
        metadata: { code: 'MUSIC_SERVICE_UNAVAILABLE', alternatives: 'zhipu:glm-5.3' },
      }],
    },
    { id: 'a-2', role: 'assistant', content: '音乐服务暂不可用，已说明替代方案。', timestamp: 40 },
  ];
}

function toolNodesOf(messages: Message[]) {
  return projectTurns(messages, 'session-1', false).turns
    .flatMap((turn) => turn.nodes)
    .filter((node) => node.type === 'tool_call');
}

describe('/goal 重开后 music_generate 的中文出路（FU1-A）', () => {
  it('hydrateToolCallResults 回填后，折叠工具行显示带 alternatives 的中文出路', () => {
    const messages = hydrateToolCallResults(reopenedGoalMessages());

    // 重开路径的水合先钉住：执行结果必须从 tool 消息回到 toolCall 上
    const toolNodes = toolNodesOf(messages);
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0].toolCall?.success).toBe(false);
    expect(toolNodes[0].toolCall?.metadata?.code).toBe('MUSIC_SERVICE_UNAVAILABLE');

    const html = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: toolNodes }));
    expect(html).toContain('可改用已配置的音乐模型：zhipu:glm-5.3');
  });

  it('没有水合时折叠行不得谎称出路（对照：结果未回填 = 无失败行）', () => {
    const toolNodes = toolNodesOf(reopenedGoalMessages());
    expect(toolNodes[0].toolCall?.success).toBeUndefined();
    const html = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: toolNodes }));
    expect(html).not.toContain('可改用已配置的音乐模型');
  });
});
