// ============================================================================
// DocumentBlock - 交互式文档查看器，支持段落选中、操作栏、Agent 联动
// 用法：Agent 输出 ```document JSON spec 或 Word 附件自动渲染
// ============================================================================

import { memo, useState, useCallback, useMemo } from 'react';
import { FileText, Copy, Check, Download, Pencil, Trash2, ListPlus, Scissors } from 'lucide-react';
import { UI } from '@shared/constants';
import { buildLocalityFeedbackMessage, type DocxLocalityAnchor } from '@shared/livePreview/localityFeedback';
import { useI18n } from '../../../../hooks/useI18n';
import { useMessageActionStore } from '../../../../stores/messageActionStore';

// ── Types ──────────────────────────────────────────────────────────────────

interface Paragraph {
  index: number;
  type: 'heading' | 'paragraph' | 'list-item';
  text: string;
  level?: number; // heading level 1-6
  textFingerprint?: string;
  previousTextFingerprint?: string;
  nextTextFingerprint?: string;
}

interface DocumentSpec {
  title?: string;
  html?: string;           // mammoth rendered HTML (for preview mode)
  paragraphs: Paragraph[];
  text?: string;           // raw text
  wordCount?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDocumentSpec(value: unknown): value is DocumentSpec {
  if (!isRecord(value) || !Array.isArray(value.paragraphs)) return false;
  return value.paragraphs.every((paragraph) => (
    isRecord(paragraph)
    && typeof paragraph.index === 'number'
    && (paragraph.type === 'heading' || paragraph.type === 'paragraph' || paragraph.type === 'list-item')
    && typeof paragraph.text === 'string'
    && (paragraph.textFingerprint === undefined || typeof paragraph.textFingerprint === 'string')
    && (paragraph.previousTextFingerprint === undefined || typeof paragraph.previousTextFingerprint === 'string')
    && (paragraph.nextTextFingerprint === undefined || typeof paragraph.nextTextFingerprint === 'string')
  ));
}

function parseSpec(raw: string): DocumentSpec | null {
  try {
    const spec: unknown = JSON.parse(raw);
    return isDocumentSpec(spec) ? spec : null;
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
  const { t } = useI18n();
  const typeLabel = paragraph.type === 'heading'
    ? `H${paragraph.level}`
    : paragraph.type === 'list-item' ? t.generativeUI.listItem : t.generativeUI.paragraph;

  const actions = [
    { key: 'rewrite', label: t.generativeUI.rewrite, icon: Pencil, color: 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20' },
    { key: 'simplify', label: t.generativeUI.simplify, icon: Scissors, color: 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20' },
    { key: 'insert_after', label: t.generativeUI.insertAfter, icon: ListPlus, color: 'text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/20' },
    { key: 'delete', label: t.common.delete, icon: Trash2, color: 'text-red-400 bg-red-500/10 hover:bg-red-500/20 border-red-500/20' },
  ];

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/80 border-t border-zinc-700 animate-fadeIn">
      <span className="text-xs text-zinc-400 shrink-0">
        {typeLabel} #{paragraph.index + 1}
      </span>
      <div className="flex items-center gap-1.5 flex-1 overflow-x-auto scrollbar-hidden">
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
  /** 缺省 = 无源文件、不可交互：不给光标手型也不给 hover 高亮，避免"看起来能点"的假象 */
  onClick?: (e: React.MouseEvent) => void;
}) {
  const interactive = onClick != null;
  const baseClass = `px-4 py-2 transition-colors border-l-2${interactive ? ' cursor-pointer' : ''}`;
  const selectedClass = isSelected
    ? 'bg-blue-500/10 border-l-blue-500'
    : `border-l-transparent${interactive ? ' hover:bg-zinc-800/50 hover:border-l-zinc-600' : ''}`;

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

export const DocumentBlock = memo(function DocumentBlock({
  spec: rawSpec,
  filePath,
}: {
  spec: string;
  /**
   * 源 .docx 的本地绝对路径。缺省时段落不可点、动作条不出现——
   * 没有源文件就没有"改文档"这回事，不给用户假的可编辑假象（与 SpreadsheetBlock 同款约定）。
   */
  filePath?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { t } = useI18n();
  const sendPrompt = useMessageActionStore((state) => state.sendPrompt);

  const parsedSpec = useMemo(() => parseSpec(rawSpec), [rawSpec]);
  const paragraphs = parsedSpec?.paragraphs || [];
  const wordCount = parsedSpec?.wordCount || 0;
  const selectedPara = selectedIndex !== null
    ? paragraphs.find((paragraph) => paragraph.index === selectedIndex) ?? null
    : null;

  const handleParagraphClick = useCallback((index: number) => {
    setSelectedIndex(prev => prev === index ? null : index);
  }, []);

  // Action handler → 文本给模型、结构化锚点给 host resolver / 写前 guard。
  const handleAction = useCallback((action: string) => {
    if (!selectedPara || !filePath) return;

    const intents: Record<string, string> = {
      rewrite: '重写这一段，保持原意但改进表达',
      simplify: '精简这一段，删除冗余内容',
      insert_after: '在这一段后面插入新内容（先给出建议的内容）',
      delete: '删除这一段，并处理好上下文衔接',
    };

    const intent = intents[action];
    if (!intent) return;

    const anchor: DocxLocalityAnchor = {
      kind: 'docx',
      filePath,
      paragraphIndex: selectedPara.index,
      text: selectedPara.text,
      paragraphType: selectedPara.type,
      ...(selectedPara.level === undefined ? {} : { level: selectedPara.level }),
      displayName: parsedSpec?.title || '文档',
    };
    void sendPrompt(buildLocalityFeedbackMessage(anchor, intent), { localityAnchor: anchor });
  }, [selectedPara, filePath, parsedSpec, sendPrompt]);

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
            {parsedSpec.title || t.generativeUI.document}
          </span>
          <span className="text-xs text-zinc-500">
            {paragraphs.length} {t.generativeUI.paragraphUnit} · {wordCount > 0 ? `${wordCount} ${t.generativeUI.wordUnit}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            {copied ? (
              <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">{t.generativeUI.copied}</span></>
            ) : (
              <><Copy className="w-3.5 h-3.5" /><span>{t.generativeUI.copy}</span></>
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
      <div className="divide-y divide-zinc-800/50">
        {paragraphs.map((para) => (
          <ParagraphItem
            key={para.index}
            para={para}
            isSelected={selectedIndex === para.index}
            onClick={filePath && para.textFingerprint
              ? () => handleParagraphClick(para.index)
              : undefined}
          />
        ))}
      </div>

      {/* Action Bar：只有拿得到源文件时才出现——否则按钮改不到任何东西 */}
      {filePath && selectedPara?.textFingerprint && (
        <ActionBar paragraph={selectedPara} onAction={handleAction} />
      )}
    </div>
  );
});
