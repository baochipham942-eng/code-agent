import React from 'react';
import { AGENT_ENGINE_LABELS } from '@shared/contract/agentEngine';
import { useI18n } from '../../../../hooks/useI18n';
import type { ImportedSessionNoticeState } from '../../../../hooks/useImportedSessionResume';

/**
 * 导入外部历史会话的 composer 上方说明行（N-EXTHISTORY-IMPORT-CHATS-RESUME）：
 * 说明「发送会开新 Neo 会话续聊、原记录不变」；没有可续接的助手回复时换成
 * 一句人话提示。composer 本身保持可见可输入。
 */
export function ImportedSessionNotice({ state }: { state: ImportedSessionNoticeState }): React.ReactElement {
  const { t } = useI18n();
  const line = state.kind === 'explain'
    ? t.chatInput.importedNotice.replace('{engine}', AGENT_ENGINE_LABELS[state.engineKind])
    : t.chatInput.importedNoticeNoAnchor;
  return (
    <p
      data-testid="imported-session-notice"
      data-notice-kind={state.kind}
      className="mb-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2 text-xs text-text-secondary"
    >
      {line}
    </p>
  );
}
