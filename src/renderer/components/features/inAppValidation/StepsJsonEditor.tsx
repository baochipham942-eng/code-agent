// ============================================================================
// StepsJsonEditor - Step 脚本（JSON）编辑器（行号 + 失焦校验）
//
// 契约：
// - 轻量增强裸 textarea，不上完整编辑器库（任务书口径）：
//   ① 左侧行号 gutter，与 textarea 同字号同行高（leading-5）、scrollTop 同步，
//      textarea wrap=off 保证行号与视觉行一一对应；
//   ② 失焦（blur）即做 JSON.parse 校验，错误信息即时显示在编辑器下方；
//      用户继续编辑时若已恢复合法则自动清除，不阻塞输入、不阻塞「运行」。
// - 文案走 i18n：parseErrorTemplate 由调用方传入（{message} 占位符）。
// ============================================================================
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface StepsJsonEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** i18n 模板，含 {message} 占位符（如 'JSON 解析失败：{message}'）。 */
  parseErrorTemplate: string;
}

export const StepsJsonEditor: React.FC<StepsJsonEditorProps> = ({ value, onChange, parseErrorTemplate }) => {
  const [parseError, setParseError] = useState<string | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const validate = useCallback((text: string) => {
    try {
      JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleChange = useCallback((next: string) => {
    onChange(next);
    // 已有报错时静默复验：恢复合法即清除，不等下次失焦。
    if (parseError) validate(next);
  }, [onChange, parseError, validate]);

  const syncGutterScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 bg-slate-900">
        <div
          ref={gutterRef}
          aria-hidden
          className="w-8 shrink-0 select-none overflow-hidden border-r border-slate-800 py-2 pr-1.5 text-right font-mono text-xs leading-5 text-zinc-600"
          data-testid="steps-editor-gutter"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1}>{i + 1}</div>
          ))}
        </div>
        <textarea
          className="min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-slate-900 px-3 py-2 font-mono text-xs leading-5 text-slate-100 outline-hidden"
          wrap="off"
          spellCheck={false}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => validate(value)}
          onScroll={syncGutterScroll}
          data-testid="steps-editor-textarea"
        />
      </div>
      {parseError && (
        <div
          className="flex shrink-0 items-start gap-1 border-t border-rose-900/60 bg-rose-950/40 px-3 py-1.5 text-[11px] text-rose-200"
          data-testid="steps-editor-parse-error"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">{parseErrorTemplate.replace('{message}', parseError)}</span>
        </div>
      )}
    </div>
  );
};
