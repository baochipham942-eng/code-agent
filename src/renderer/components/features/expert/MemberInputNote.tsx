// 主对话里的折叠记录：用户绕过团长直接给某位成员补了一句 / 让他改道（N-SUBAGENT-INPUT）。
// 一行灰字，不占气泡；团长收工汇总时看得见用户说了什么。
import React from 'react';
import type { TraceNode } from '@shared/contract/trace';
import { useI18n } from '../../../hooks/useI18n';

export const MemberInputNote: React.FC<{ node: TraceNode }> = ({ node }) => {
  const { t } = useI18n();
  const record = node.metadata?.memberInput;
  if (!record) return null;
  const label = (record.mode === 'redirect' ? t.expert.memberBar.mainRecordRedirect : t.expert.memberBar.mainRecordSupplement)
    .replace('{name}', record.memberName);
  return (
    <p data-testid="member-input-note" className="truncate text-xs text-zinc-500" title={node.content}>
      {label}：{node.content}
    </p>
  );
};
