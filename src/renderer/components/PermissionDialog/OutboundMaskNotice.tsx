import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '../primitives';

interface OutboundMaskNoticeProps {
  message: string;
}

export function OutboundMaskNotice({ message }: OutboundMaskNoticeProps) {
  return (
    <Badge
      role="note"
      data-testid="outbound-mask-notice"
      className="w-full items-start gap-2 rounded-lg border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs font-normal leading-5 text-badge-warning"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
      <span>{message}</span>
    </Badge>
  );
}
