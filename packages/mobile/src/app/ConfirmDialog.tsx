import { useEffect, useRef } from 'react';

/**
 * 通用模态确认弹窗（N-COMPANION-LOGOUT-CONFIRM-DIALOG，爸 build 57 真机拍板：
 * 「退出应该是弹窗」——手机端此前没有居中弹窗组件，只有底部 sheet（SheetHost.tsx，
 * `role="dialog"`）。这个组件走 `alertdialog`（危险/需要立即决定的确认，不是普通对话框）。
 *
 * 直接渲染在调用方页面内（不走 portal）：fixed 定位相对视口，只要祖先链上没有
 * transform/filter/perspective/will-change 建立新的包含块就不会失效——SettingsPage 所在的
 * `.sheet`/`.sheet-content` 都没有这些属性（只有 `overflow: auto`，不影响 fixed），已核对，
 * 见证据档。真出现这类祖先时再改 portal 到 document.body。
 */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel, confirmTestId, cancelTestId }: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 危险操作（比如退出登录）：确认按钮用 .danger 的红。 */
  danger?: boolean;
  /** 提交中：两个按钮都锁住，防止重复点击/取消打断正在进行的请求。 */
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  /** 通用组件不预设业务语义的 testid，调用方各自指名。 */
  confirmTestId?: string;
  cancelTestId?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 打开时焦点落到「取消」——确认才是危险动作，默认焦点不该落在它上面；
    // 关闭（unmount）时把焦点还给触发弹窗的那个元素（通常是「退出登录」按钮）。
    const previous = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus({ preventScroll: true });
    return () => { previous?.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    // capture 阶段先于 MobileRoot 那个全局 Escape 监听（bubble 阶段，把 Escape 当「返回上一
    // 级」处理）拿到事件：弹窗开着时 Escape 只应该取消弹窗，不该顺带把整个 sheet 也退掉。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
      if (event.key !== 'Tab') return;
      const items = card.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onCancel]);

  return <div className="confirm-scrim" data-testid="confirm-dialog-scrim" onClick={onCancel}>
    <div ref={card} className="confirm-card" role="alertdialog" aria-modal="true"
      aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-body"
      onClick={event => event.stopPropagation()}>
      <h3 id="confirm-dialog-title">{title}</h3>
      <p id="confirm-dialog-body" className="caption">{body}</p>
      <button type="button" data-testid={confirmTestId} className={danger ? 'primary danger' : 'primary'} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
      <button type="button" ref={cancelButton} data-testid={cancelTestId} className="secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
    </div>
  </div>;
}
