export const engineModelPanelZh = {
  engineModelPanel: {
    loadingSubtitle: '正在读取模型列表…',
    searchPlaceholder: '搜索 {engine} 模型…',
    noDetectedModel: '尚未探测到模型',
    clientManagedModel: '官方客户端管理模型',
    recommended: '推荐',
    noMatchingModel: '没有探测到匹配模型',
    clientDefaultTitle: '由官方客户端选择默认模型',
    clientDefaultDescription: '当前客户端没有返回可信模型目录，Neo 不会虚构可选模型。',
    loadFailedSubtitle: '模型列表加载失败',
    loadFailedDescription: '暂时连不上 {engine}，模型列表加载失败。请检查网络后点「重试」；若多次失败，可到「设置 → 引擎」重新连接。',
    retry: '重试',
    openEngineSettings: '设置 → 引擎',
  },
};

export const engineModelPanelEn: typeof engineModelPanelZh = {
  engineModelPanel: {
    loadingSubtitle: 'Reading model list...',
    searchPlaceholder: 'Search {engine} models...',
    noDetectedModel: 'No model detected yet',
    clientManagedModel: 'Models managed by the official client',
    recommended: 'Recommended',
    noMatchingModel: 'No matching model was detected',
    clientDefaultTitle: 'Default model selected by the official client',
    clientDefaultDescription: 'The client did not return a trusted model catalog, so Neo will not invent model choices.',
    loadFailedSubtitle: 'Model list failed to load',
    loadFailedDescription: 'Neo cannot reach {engine} right now, so the model list failed to load. Check your network and select Retry. If it keeps failing, reconnect it under Settings → Engines.',
    retry: 'Retry',
    openEngineSettings: 'Settings → Engines',
  },
};
