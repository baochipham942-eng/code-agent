// ============================================================================
// Chinese (Simplified) Translations - 简体中文
// ============================================================================

export const zh = {
  // Common
  common: {
    save: '保存',
    cancel: '取消',
    close: '关闭',
    confirm: '确认',
    delete: '删除',
    edit: '编辑',
    loading: '加载中...',
    error: '错误',
    success: '成功',
    active: '当前',
    coming: '即将推出',
  },

  // Settings Modal
  settings: {
    title: '设置',
    tabs: {
      model: '模型',
      disclosure: '界面',
      appearance: '外观',
      language: '语言',
      about: '关于',
    },
  },

  // Model Settings
  model: {
    title: '模型提供商',
    apiKey: 'API 密钥',
    apiKeyPlaceholder: '请输入您的 API 密钥',
    apiKeyHint: '您的 API 密钥仅存储在本地，不会发送到我们的服务器。',
    modelSelect: '模型',
    temperature: '温度',
    temperaturePrecise: '精确',
    temperatureCreative: '创意',
    providers: {
      deepseek: {
        name: 'DeepSeek',
        description: 'DeepSeek 聊天 API',
      },
      anthropic: {
        name: 'Claude',
        description: 'Anthropic Claude API',
      },
      openai: {
        name: 'OpenAI',
        description: 'OpenAI GPT API',
      },
    },
  },

  // Disclosure Settings (Progressive Disclosure)
  disclosure: {
    title: '渐进披露',
    description: '控制界面显示的复杂程度。从简单模式开始，根据需要逐步解锁更多功能。',
    whyTitle: '为什么要渐进披露？',
    whyDescription:
      '渐进披露通过只显示当前需要的内容来减少认知负担。从"简单"模式开始学习基础知识，然后随着对工具的熟悉逐渐提高级别。这种方法既能防止新用户感到不知所措，又能为专家用户提供完整的功能。',
    levels: {
      simple: {
        name: '简单',
        description: '适合初学者的简洁界面',
        features: ['基础聊天界面', '仅基本工具', '最少配置', '自动生成提示'],
      },
      standard: {
        name: '标准',
        description: '日常使用的均衡功能',
        features: ['待办事项面板', '代际选择器', '模型设置', '会话历史'],
      },
      advanced: {
        name: '高级',
        description: '高级用户的完整控制',
        features: ['规划面板', '发现与错误追踪', '工具执行详情', '自定义提示'],
      },
      expert: {
        name: '专家',
        description: '开发者的完整访问权限',
        features: ['原始 API 响应', 'Token 使用指标', '调试控制台', 'MCP 服务器配置'],
      },
    },
  },

  // Appearance Settings
  appearance: {
    theme: '主题',
    themes: {
      dark: '深色',
      light: '浅色',
      auto: '自动',
    },
    fontSize: '字体大小',
    fontSizes: {
      small: '小',
      medium: '中',
      large: '大',
    },
  },

  // Language Settings
  language: {
    title: '界面语言',
    description: '选择应用界面显示的语言',
    options: {
      zh: {
        name: '简体中文',
        native: '简体中文',
      },
      en: {
        name: '英语',
        native: 'English',
      },
    },
  },

  // About Section
  about: {
    title: '关于',
    version: '版本',
    description:
      'Code Agent 是一个 AI 驱动的编程助手，展示了 AI Agent 能力在不同代际间的演进。专为学习和研究目的而构建。',
    technologies: '技术栈',
    madeWith: '由 AI 辅助制作',
  },
};

export type Translations = typeof zh;
