// ============================================================================
// ImportedSessionNotice 组件测试（N-EXTHISTORY-IMPORT-CHATS-RESUME）
// ----------------------------------------------------------------------------
// 导入外部历史会话的 composer 上方说明行：默认解释「发送开新会话续聊、原记录
// 不变」（带引擎名），无可续接助手回复时换一句人话。zh/en 词条都要真实渲染出来。
// ============================================================================

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { ImportedSessionNotice } from '../../../src/renderer/components/features/chat/ChatInput/ImportedSessionNotice';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

describe('ImportedSessionNotice（导入历史会话的说明行）', () => {
  it('可续接：说明行点名引擎，说明发送会开新 Neo 会话、原记录不变', () => {
    const html = renderToStaticMarkup(
      <ImportedSessionNotice state={{ kind: 'explain', engineKind: 'claude_code' }} />,
    );
    expect(html).toContain('data-testid="imported-session-notice"');
    expect(html).toContain('data-notice-kind="explain"');
    expect(html).toContain(zh.chatInput.importedNotice.replace('{engine}', 'Claude Code'));
  });

  it('Codex 会话同样点名引擎', () => {
    const html = renderToStaticMarkup(
      <ImportedSessionNotice state={{ kind: 'explain', engineKind: 'codex_cli' }} />,
    );
    expect(html).toContain(zh.chatInput.importedNotice.replace('{engine}', 'Codex CLI'));
  });

  it('无锚点：换成「暂无可续接回复」的人话，不出现发送按钮或错误码', () => {
    const html = renderToStaticMarkup(
      <ImportedSessionNotice state={{ kind: 'no_anchor', engineKind: 'claude_code' }} />,
    );
    expect(html).toContain('data-notice-kind="no_anchor"');
    expect(html).toContain(zh.chatInput.importedNoticeNoAnchor);
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/error|code/i);
  });

  it('英文词条同形状可用（zh/en 成对维护）', () => {
    expect(en.chatInput.importedNotice).toContain('{engine}');
    expect(en.chatInput.importedNoticeNoAnchor).not.toBe(zh.chatInput.importedNoticeNoAnchor);
    expect(en.chatInput.importedSendBlocked).not.toBe(zh.chatInput.importedSendBlocked);
    expect(en.chatInput.importedForkFailed).toContain('{reason}');
  });
});
