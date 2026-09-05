const messages = {
  zh: {
    unavailable: '当前无法压缩上下文。',
    busy: '任务运行中，请结束后再压缩。',
    databaseUnavailable: '会话存储暂不可用，原有历史已保留。',
    unchanged: '当前没有可压缩的历史上下文。',
    changed: '上下文已变化，请重新压缩。',
    failed: '上下文压缩失败，原有历史已保留。',
    invalid: '摘要未通过完整性检查，原有历史已保留。',
    notSmaller: '摘要没有缩小上下文，原有历史已保留。',
    completed: (before: number, after: number) => `上下文已压缩：${before} → ${after} tokens。`,
  },
  en: {
    unavailable: 'Context compaction is unavailable.',
    busy: 'Wait for the current task to finish before compacting.',
    databaseUnavailable: 'Session storage is unavailable. The original history was kept.',
    unchanged: 'There is no history that can be compacted yet.',
    changed: 'The context changed. Please compact again.',
    failed: 'Context compaction failed. The original history was kept.',
    invalid: 'The summary did not pass validation. The original history was kept.',
    notSmaller: 'The summary did not reduce the context. The original history was kept.',
    completed: (before: number, after: number) => `Context compacted: ${before} → ${after} tokens.`,
  },
} as const;

export function getCompactionCommandMessages(locale: 'zh' | 'en') {
  return messages[locale];
}
