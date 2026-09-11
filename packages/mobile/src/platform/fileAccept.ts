// 手机文件选择器的 accept 列表。放行权威是 src/shared/constants/companion.ts 的
// FILE_EXT_MIME（扩展名优先），本列表由 tests/unit/mobile/fileAccept.test.ts 与它钉齐。
export const COMPANION_PICKER_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/zip', 'video/mp4', 'audio/mpeg', 'audio/mp4', 'audio/wav',
] as const;

export const IMAGE_ACCEPT = COMPANION_PICKER_MIME_TYPES.filter(type => type.startsWith('image/')).join(',');
export const FILE_ACCEPT = COMPANION_PICKER_MIME_TYPES.join(',');
