// ============================================================================
// SoulIndicator - StatusBar 人格指示器
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Ghost } from 'lucide-react';

type SoulSource = 'project' | 'user' | 'builtin';

const SOURCE_LABELS: Record<SoulSource, { label: string; color: string }> = {
  project: { label: 'PROFILE', color: 'text-violet-400' },
  user: { label: 'SOUL', color: 'text-cyan-400' },
  builtin: { label: '默认', color: 'text-gray-500' },
};

export function SoulIndicator() {
  const [source, setSource] = useState<SoulSource>('builtin');

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await window.domainAPI?.invoke<{ source: SoulSource }>('soul', 'getStatus', {});
        if (res?.data?.source) setSource(res.data.source);
      } catch { /* ignore */ }
    };
    fetchStatus();
  }, []);

  if (source === 'builtin') return null;

  const { label, color } = SOURCE_LABELS[source];

  return (
    <span className={`flex items-center gap-1 ${color}`} title={`当前人格: ${label}`}>
      <Ghost size={12} />
      <span>{label}</span>
    </span>
  );
}
