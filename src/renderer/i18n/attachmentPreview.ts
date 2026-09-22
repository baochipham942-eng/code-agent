// ============================================================================
// 会话内附件卡片（AttachmentPreview）加载失败兜底文案 —— zh/en 同文件相邻维护。
// ============================================================================

export const attachmentPreviewZh = {
  attachmentPreview: {
    imageUnavailable: '无法预览此图片',
    imageUnavailableHint: '文件可能已被移动或暂时没有访问权限',
    imageTooLarge: '图片过大，已跳过内联预览',
  },
};

export const attachmentPreviewEn: typeof attachmentPreviewZh = {
  attachmentPreview: {
    imageUnavailable: 'Unable to preview this image',
    imageUnavailableHint: 'The file may have been moved or is temporarily inaccessible',
    imageTooLarge: 'Image too large; inline preview skipped',
  },
};
