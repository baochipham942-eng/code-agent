// 聊天流 Mermaid 图卡片（缩放/平移 + 标注即编辑）文案。原本内联在 zh.ts/en.ts，2026-07-31 抽成域文件
// 为根文件腾出 1000 行门的余量（新键一律进域文件，样板见 neoTopics.ts）。
export const mermaidZh = {
  mermaid: {
    zoomIn: '放大',
    zoomOut: '缩小',
    zoomReset: '适配窗口',
    zoomHint: '⌘/Ctrl + 滚轮缩放，拖拽平移',
    copyCode: '源码',
    copied: '已复制',
    selectedLabel: '已选：',
    editPlaceholder: '一句话描述怎么改，例如"改成两步验证"',
    send: '发送',
    cancel: '取消',
    editPrompt: '请修改这张 Mermaid 图中的「{label}」：{instruction}\n\n当前图表完整源码：\n{codeBlock}\n请输出修改后的完整 mermaid 代码块，未提及的部分保持不变。',
  },
};

export const mermaidEn: typeof mermaidZh = {
  mermaid: {
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Fit to view',
    zoomHint: '⌘/Ctrl + scroll to zoom, drag to pan',
    copyCode: 'Code',
    copied: 'Copied!',
    selectedLabel: 'Selected: ',
    editPlaceholder: 'Describe the change, e.g. "split into two steps"',
    send: 'Send',
    cancel: 'Cancel',
    editPrompt: 'Please update "{label}" in this Mermaid diagram: {instruction}\n\nCurrent diagram source:\n{codeBlock}\nReply with the complete updated mermaid code block, keeping everything else unchanged.',
  },
};
