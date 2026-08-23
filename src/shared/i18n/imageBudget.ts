export type ImageBudgetLocale = 'zh' | 'en';

const IMAGE_BUDGET_MESSAGES = {
  zh: {
    historyOmitted: (count: number) =>
      `[为控制本轮模型请求大小，已省略 ${count} 张较早的历史图片；原图仍保留在聊天记录中。]`,
  },
  en: {
    historyOmitted: (count: number) =>
      `[${count} older historical image${count === 1 ? '' : 's'} omitted from this model request to stay within payload limits; the originals remain in chat history.]`,
  },
} as const;

export function formatHistoricalImageOmission(count: number, locale: ImageBudgetLocale): string {
  return IMAGE_BUDGET_MESSAGES[locale].historyOmitted(count);
}
