import { useEffect, useMemo } from 'react';
import { bytesToArrayBuffer } from '../../platform/fileCache';

// 预览 object URL 只在 preview 变化时创建、卸载/变更时 revoke——sync 每秒重渲染不能累积 Blob。
export function PreviewMedia({ name, mimeType, bytes }: { name: string; mimeType: string; bytes: Uint8Array }) {
  const needsUrl = mimeType.startsWith('image/') || mimeType.startsWith('video/');
  const url = useMemo(() => needsUrl
    ? URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: mimeType })) : null,
  [needsUrl, mimeType, bytes]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url && mimeType.startsWith('image/')) return <img className="preview-media" alt={name} src={url} />;
  if (url && mimeType.startsWith('video/')) return <video className="preview-media" controls playsInline src={url} />;
  if (mimeType.startsWith('text/')) return <pre className="preview-text">{new TextDecoder().decode(bytes)}</pre>;
  return <p>{name}</p>;
}
