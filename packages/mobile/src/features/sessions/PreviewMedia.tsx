import { useEffect, useMemo } from 'react';
import { bytesToArrayBuffer } from '../../platform/fileCache';
import { canInlinePdf } from '../../platform/previewCapabilities';
import { messages } from '../../i18n';

function isPdf(mimeType: string): boolean {
  return mimeType.split(';')[0] === 'application/pdf';
}

// 预览 object URL 只在 preview 变化时创建、卸载/变更时 revoke——sync 每秒重渲染不能累积 Blob。
export function PreviewMedia({ name, mimeType, bytes, text, onSave }: {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  text?: ReturnType<typeof messages>;
  onSave?: () => void;
}) {
  const copy = text ?? messages(typeof navigator === 'undefined' ? 'en' : navigator.language);
  const pdf = isPdf(mimeType);
  const inlinePdf = pdf && canInlinePdf();
  const needsUrl = mimeType.startsWith('image/') || mimeType.startsWith('video/') || inlinePdf;
  const url = useMemo(() => needsUrl
    ? URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: mimeType })) : null,
  [needsUrl, mimeType, bytes]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url && mimeType.startsWith('image/')) return <img className="preview-media" alt={name} src={url} />;
  if (url && mimeType.startsWith('video/')) return <video className="preview-media" controls playsInline src={url} />;
  if (url && inlinePdf) return <iframe className="preview-media preview-pdf" title={name} src={url} />;
  if (pdf) {
    return <div className="preview-fallback" role="status">
      <p>{copy.pdfInlineUnavailable}</p>
      {onSave ? <button type="button" className="primary" onClick={onSave}>{copy.pdfOpenExternally}</button> : null}
    </div>;
  }
  if (mimeType.startsWith('text/')) return <pre className="preview-text">{new TextDecoder().decode(bytes)}</pre>;
  return <p>{name}</p>;
}
