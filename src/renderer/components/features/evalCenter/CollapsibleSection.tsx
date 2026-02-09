// ============================================================================
// CollapsibleSection - 通用可折叠区域
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultOpen = true,
  onToggle,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next && onToggle) onToggle();
        }}
        className="flex items-center justify-between w-full text-xs font-medium text-zinc-400 hover:text-zinc-300 transition py-1.5"
      >
        <span>{title}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${isOpen ? '' : '-rotate-90'}`}
        />
      </button>
      {isOpen && <div className="mt-1">{children}</div>}
    </div>
  );
};
