// ============================================================================
// Primitives 层组件专属词条（ErrorBoundary / CitationList）—— 非通用词，不进 common。
// zh/en 同文件相邻维护；独立文件避免 zh.ts/en.ts 撞 max-lines(1000) 门。
// ============================================================================

export const modalPrimitivesZh = {
  errorBoundary: {
    title: '出错了',
    message: '应用遇到了一个意外错误，请尝试重试或刷新页面。',
    viewDetails: '查看错误详情',
    refresh: '刷新页面',
  },
  citations: {
    label: '引用:',
  },
};

export const modalPrimitivesEn: typeof modalPrimitivesZh = {
  errorBoundary: {
    title: 'Something went wrong',
    message: 'The app hit an unexpected error. Try again or refresh the page.',
    viewDetails: 'View error details',
    refresh: 'Refresh page',
  },
  citations: {
    label: 'Citations:',
  },
};
