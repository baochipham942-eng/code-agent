// ============================================================================
// ReportStyleSelector - 报告风格选择器
// 深度研究模式下选择报告输出风格
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, FileText } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export type ReportStyle =
  | 'default'
  | 'academic'
  | 'popular_science'
  | 'news'
  | 'social_media'
  | 'strategic_investment';

interface StyleOption {
  value: ReportStyle;
  label: string;
  description: string;
}

interface ReportStyleSelectorProps {
  value: ReportStyle;
  onChange: (style: ReportStyle) => void;
  disabled?: boolean;
}

// ============================================================================
// 风格选项配置
// ============================================================================

const STYLE_OPTIONS: StyleOption[] = [
  { value: 'default', label: '默认', description: '通用报告格式' },
  { value: 'academic', label: '学术论文', description: '正式、引用规范' },
  { value: 'popular_science', label: '科普文章', description: '通俗易懂、有趣' },
  { value: 'news', label: '新闻报道', description: '倒金字塔、简洁' },
  { value: 'social_media', label: '社交媒体', description: '简短、列表化' },
  { value: 'strategic_investment', label: '投资分析', description: '深度、量化数据' },
];

// ============================================================================
// 组件
// ============================================================================

export const ReportStyleSelector: React.FC<ReportStyleSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = STYLE_OPTIONS.find(opt => opt.value === value);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-md text-sm
          bg-surface-800 border border-zinc-700 hover:border-zinc-600
          transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        <FileText className="w-4 h-4 text-zinc-400" />
        <span className="text-zinc-400">报告风格:</span>
        <span className="text-white">{selectedOption?.label}</span>
        <ChevronDown
          className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isOpen && !disabled && (
        <div className="absolute bottom-full left-0 mb-2 w-64 py-1 bg-surface-800 border border-zinc-700 rounded-lg shadow-xl z-20">
          {STYLE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`
                w-full px-3 py-2 text-left hover:bg-surface-700 transition-colors
                ${value === option.value ? 'bg-surface-700' : ''}
              `}
            >
              <div className="text-sm text-white">{option.label}</div>
              <div className="text-xs text-zinc-500">{option.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
