// ============================================================================
// DocumentBlock - 交互式文档查看器，支持段落选中、操作栏、Agent 联动
// 用法：Agent 输出 ```document JSON spec 或 Word 附件自动渲染
// ============================================================================

import { memo, useState, useCallback, useMemo } from 'react';
import { FileText, Copy, Check, Download, Pencil, Trash2, Type, ListPlus, Scissors } from 'lucide-react';
import { UI } from '@shared/constants';

// ── Types ──────────────────────────────────────────────────────────────────

interface Paragraph {
  index: number;
  type: 'heading' | 'paragraph' | 'list-item';
  text: string;
  level?: number; // heading level 1-6
}

interface DocumentSpec {
  title?: string;
  html?: string;           // mammoth rendered HTML (for preview mode)
  paragraphs: Paragraph[];
  text?: string;           // raw text
  wordCount?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseSpec(raw: string): DocumentSpec | null {
  try {
    const spec = JSON.parse(raw);
    if (!spec || !Array.isArray(spec.paragraphs)) return null;
    return spec as DocumentSpec;
  } catch {
    return null;
  }
}

// ── Action Bar ─────────────────────────────────────────────────────────────

const ActionBar = memo(function ActionBar({
  paragraph,
  onAction,
}: {
  paragraph: Paragraph;
  onAction: (action: string) => void;
}) {
  const typeLabel = paragraph.type === 'heading'
    ? `H${paragraph.level}`
    : paragraph.type === 'list-item' ? '列表项' : '段落';

  const actions = [
    { key: 'rewrite', label: '重写', icon: Pencil, color: 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20' },
    { key: 'simplify', label: '精简', icon: Scissors, color: 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20' },
    { key: 'restyle', label: '改格式', icon: Type, color: 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/20' },
    { key: 'insert_after', label: '后面插入', icon: ListPlus, color: 'text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/20' },
    { key: 'delete', label: '删除', icon: Trash2, color: 'text-red-400 bg-red-500/10 hover:bg-red-500/20 border-red-500/20' },
  ];

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/80 border-t border-zinc-700 animate-fadeIn">
      <span className="text-xs text-zinc-400 shrink-0">
        {typeLabel} #{paragraph.index + 1}
      </span>
      <div className="flex items-center gap-1.5 flex-1 overflow-x-auto">
        {actions.map(({ key, label, icon: Icon, color }) => (
          <button
            key={key}
            onClick={() => onAction(key)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors shrink-0 ${color}`}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});

// ── Paragraph Renderer ─────────────────────────────────────────────────────

const ParagraphItem = memo(function ParagraphItem({
  para,
  isSelected,
  onClick,
}: {
  para: Paragraph;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const baseClass = 'px-4 py-2 cursor-pointer transition-colors border-l-2';
  const selectedClass = isSelected
    ? 'bg-blue-500/10 border-l-blue-500'
    : 'border-l-transparent hover:bg-zinc-800/50 hover:border-l-zinc-600';

  if (para.type === 'heading') {
    const sizeClass = para.level === 1 ? 'text-lg font-bold'
      : para.level === 2 ? 'text-base font-semibold'
      : 'text-sm font-semibold';
    return (
      <div className={`${baseClass} ${selectedClass}`} onClick={onClick}>
        <div className={`${sizeClass} text-zinc-200`}>{para.text}</div>
      </div>
    );
  }

  if (para.type === 'list-item') {
    return (
      <div className={`${baseClass} ${selectedClass} pl-8`} onClick={onClick}>
        <div className="text-sm text-zinc-300 flex items-start gap-2">
          <span className="text-zinc-500 shrink-0 mt-0.5">•</span>
          <span>{para.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`${baseClass} ${selectedClass}`} onClick={onClick}>
      <div className="text-sm text-zinc-300 leading-relaxed">{para.text}</div>
    </div>
  );
});

// ── Main Component ─────────────────────────────────────────────────────────

export const DocumentBlock = memo(function DocumentBlock({ spec: rawSpec }: { spec: string }) {
  const [copied, setCopied] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const parsedSpec = useMemo(() => parseSpec(rawSpec), [rawSpec]);
  const paragraphs = parsedSpec?.paragraphs || [];
  const wordCount = parsedSpec?.wordCount || 0;
  const selectedPara = selectedIndex !== null ? paragraphs[selectedIndex] : null;

  const handleParagraphClick = useCallback((index: number) => {
    setSelectedIndex(prev => prev === index ? null : index);
  }, []);

  // Action handler → iact:send with document context
  const handleAction = useCallback((action: string) => {
    if (!selectedPara) return;

    const context = `第 ${selectedPara.index + 1} 段（${selectedPara.type === 'heading' ? 'H' + selectedPara.level + ' 标题' : '段落'}）：\n"${selectedPara.text}"`;

    const prompts: Record<string, string> = {
      rewrite: `请重写以下文档段落，保持原意但改进表达：\n${context}`,
      simplify: `请精简以下文档段落，删除冗余内容：\n${context}`,
      restyle: `请将以下段落改变格式（例如改为标题、列表、或调整层级）：\n${context}`,
      insert_after: `请在以下段落后面插入新内容：\n${context}\n\n请建议要插入的内容。`,
      delete: `请确认删除以下段落：\n${context}\n\n删除后如需调整上下文衔接也请一并处理。`,
    };

    const prompt = prompts[action];
    if (prompt) {
      window.dispatchEvent(new CustomEvent('iact:send', { detail: prompt }));
    }
  }, [selectedPara]);

  // Copy full text
  const handleCopy = useCallback(async () => {
    const text = parsedSpec?.text || paragraphs.map(p => p.text).join('\n\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [parsedSpec, paragraphs]);

  // Download as txt
  const handleDownload = useCallback(() => {
    const text = parsedSpec?.text || paragraphs.map(p => p.text).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${parsedSpec?.title || 'document'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [parsedSpec, paragraphs]);

  if (!parsedSpec || paragraphs.length === 0) return null;

  return (
    <div className="my-3 rounded-xl bg-zinc-900 overflow-hidden border border-zinc-700 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-xs font-medium text-blue-400">
            {parsedSpec.title || 'Document'}
          </span>
          <span className="text-xs text-zinc-500">
            {paragraphs.length} 段 · {wordCount > 0 ? `${wordCount} 词` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            {copied ? (
              <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">Copied!</span></>
            ) : (
              <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>
            )}
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>TXT</span>
          </button>
        </div>
      </div>

      {/* Document Body */}
      <div className="max-h-[400px] overflow-auto divide-y divide-zinc-800/50">
        {paragraphs.map((para) => (
          <ParagraphItem
            key={para.index}
            para={para}
            isSelected={selectedIndex === para.index}
            onClick={() => handleParagraphClick(para.index)}
          />
        ))}
      </div>

      {/* Action Bar (when a paragraph is selected) */}
      {selectedPara && (
        <ActionBar paragraph={selectedPara} onAction={handleAction} />
      )}
    </div>
  );
});
