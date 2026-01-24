// ============================================================================
// English Translations
// ============================================================================

import type { Translations } from './zh';

export const en: Translations = {
  // Common
  common: {
    save: 'Save',
    saving: 'Saving...',
    saved: 'Saved!',
    cancel: 'Cancel',
    close: 'Close',
    confirm: 'Confirm',
    delete: 'Delete',
    edit: 'Edit',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    active: 'Active',
    coming: 'Coming',
  },

  // Settings Modal
  settings: {
    title: 'Settings',
    tabs: {
      general: 'General',
      model: 'Model',
      disclosure: 'Disclosure',
      appearance: 'Appearance',
      language: 'Language',
      data: 'Data',
      cloud: 'Cloud',
      update: 'Update',
      about: 'About',
    },
    general: {
      modeTitle: 'Application Mode',
      modeDescription: 'Choose the mode that fits your workflow',
      developerMode: 'Developer Mode',
      developerModeDesc: 'Show full tool call details and parameters',
      coworkMode: 'Cowork Mode',
      coworkModeDesc: 'Simplified display for AI collaboration',
    },
    cloud: {
      title: 'Cloud Config',
      description: 'System Prompt, Skills and other configurations are fetched from cloud in real-time.',
    },
  },

  // Update Settings
  update: {
    title: 'Version Update',
    description: 'Check and download the latest version of Code Agent',
    currentVersion: 'Current Version',
    checking: 'Checking...',
    checkNow: 'Check for Updates',
    checkError: 'Failed to check for updates, please try again later',
    newVersion: 'New version available',
    upToDate: 'You are up to date',
    download: 'Update Now',
  },

  // Model Settings
  model: {
    title: 'Model Provider',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Enter your API key',
    apiKeyHint: 'Your API key is stored locally and never sent to our servers.',
    modelSelect: 'Model',
    temperature: 'Temperature',
    temperaturePrecise: 'Precise',
    temperatureCreative: 'Creative',
    providers: {
      deepseek: {
        name: 'DeepSeek',
        description: 'DeepSeek Chat API',
      },
      anthropic: {
        name: 'Claude',
        description: 'Anthropic Claude API',
      },
      openai: {
        name: 'OpenAI',
        description: 'OpenAI GPT API',
      },
      openrouter: {
        name: 'OpenRouter',
        description: 'Proxy (Gemini/Claude/GPT)',
      },
    },
  },

  // Disclosure Settings (Progressive Disclosure)
  disclosure: {
    title: 'Progressive Disclosure',
    description:
      'Control how much complexity is shown in the interface. Start simple and unlock more features as you need them.',
    whyTitle: 'Why Progressive Disclosure?',
    whyDescription:
      'Progressive disclosure reduces cognitive load by showing only what\'s needed at each moment. Start with "Simple" to learn the basics, then gradually increase the level as you become more comfortable with the tool. This approach helps prevent overwhelming new users while still providing full power to experts.',
    levels: {
      simple: {
        name: 'Simple',
        description: 'Clean interface for beginners',
        features: [
          'Basic chat interface',
          'Essential tools only',
          'Minimal configuration',
          'Auto-generated prompts',
        ],
      },
      standard: {
        name: 'Standard',
        description: 'Balanced features for daily use',
        features: ['Todo list panel', 'Generation selector', 'Model settings', 'Session history'],
      },
      advanced: {
        name: 'Advanced',
        description: 'Full control for power users',
        features: [
          'Planning panel',
          'Findings & errors tracking',
          'Tool execution details',
          'Custom prompts',
        ],
      },
      expert: {
        name: 'Expert',
        description: 'Complete access for developers',
        features: [
          'Raw API responses',
          'Token usage metrics',
          'Debug console',
          'MCP server config',
        ],
      },
    },
    devMode: {
      title: 'Developer Options',
      autoApprove: 'Auto-approve all permissions',
      autoApproveDescription: 'Skip all permission dialogs in dev mode for faster testing. Recommended to disable in production.',
    },
  },

  // Appearance Settings
  appearance: {
    theme: 'Theme',
    themes: {
      dark: 'Dark',
      light: 'Light',
      auto: 'Auto',
    },
    fontSize: 'Font Size',
    fontSizes: {
      small: 'Small',
      medium: 'Medium',
      large: 'Large',
    },
  },

  // Language Settings
  language: {
    title: 'Interface Language',
    description: 'Choose the language for the application interface',
    options: {
      zh: {
        name: 'Chinese (Simplified)',
        native: '简体中文',
      },
      en: {
        name: 'English',
        native: 'English',
      },
    },
  },

  // About Section
  about: {
    title: 'About',
    version: 'Version',
    description:
      'Code Agent is an AI-powered coding assistant that demonstrates the evolution of AI agent capabilities across different generations. Built for learning and research purposes.',
    technologies: 'Technologies',
    madeWith: 'Made with AI assistance',
  },

  // Memory Tab
  memory: {
    title: 'Memory Management',
    description: 'Knowledge AI learned from conversations and your preferences',
    categories: {
      aboutMe: 'About Me',
      aboutMeDesc: 'Identity, role, communication style',
      preference: 'My Preferences',
      preferenceDesc: 'Format, style, tool preferences',
      frequentInfo: 'Frequent Info',
      frequentInfoDesc: 'Emails, templates, common data',
      learned: 'Learned',
      learnedDesc: 'Patterns and habits observed by AI',
    },
    source: {
      explicit: 'User Defined',
      learned: 'AI Learned',
    },
    actions: {
      import: 'Import',
      export: 'Export',
      clearCategory: 'Clear this category',
    },
    stats: {
      total: '{count} memories total',
      aiLearned: 'AI Learned',
      userDefined: 'User Defined',
      recentlyAdded: 'Added this week',
    },
    empty: {
      title: 'No Memories Yet',
      description: 'AI will learn from conversations, or add your preferences manually',
    },
    edit: {
      title: 'Edit Memory',
      category: 'Category',
      content: 'Content',
      contentPlaceholder: 'Enter memory content...',
      save: 'Save',
      cancel: 'Cancel',
    },
    notification: {
      learned: 'I remembered',
      confirmTitle: 'Confirm Memory',
      confirmDescription: 'AI learned the following. Save it?',
      accept: 'Save',
      reject: 'Skip',
      timeout: 'Confirmation timeout',
    },
    messages: {
      updateSuccess: 'Memory updated',
      deleteSuccess: 'Memory deleted',
      exportSuccess: 'Export successful',
      importSuccess: 'Imported {count} memories',
      clearSuccess: 'Cleared {count} memories',
      updateFailed: 'Update failed',
      deleteFailed: 'Delete failed',
      exportFailed: 'Export failed',
      importFailed: 'Import failed',
      invalidJson: 'Invalid JSON file',
    },
  },

  // Generation Badge
  generation: {
    selectTitle: 'Select Generation',
    toolCount: '{count} tools',
    footer: 'Switch generations to compare AI Agent capability evolution',
    capabilities: {
      gen1: ['Command Exec', 'File I/O'],
      gen2: ['Pattern Search', 'Directory Nav'],
      gen3: ['Task Planning', 'User Interaction', 'Sub-agents'],
      gen4: ['Web Access', 'MCP Ecosystem', 'Skills'],
      gen5: ['Long-term Memory', 'RAG Retrieval', 'Code Index'],
      gen6: ['Screenshot', 'Desktop Control', 'Browser Automation'],
      gen7: ['Workflow Orchestration', 'Agent Spawning', 'Messaging'],
      gen8: ['Self-evaluation', 'Pattern Learning', 'Strategy Optimization', 'Tool Creation'],
    },
  },

  // Task Panel (Right Sidebar)
  taskPanel: {
    title: 'Task Info',
    progress: 'Progress',
    workingFolder: 'Working Folder',
    context: 'Context',
    connectors: 'Connectors',
    skills: 'Skills',
    noWorkspace: 'No workspace selected',
    noRecentFiles: 'No recent files',
    noConnectors: 'No connectors configured',
    viewAllConnectors: 'View all connectors',
    working: 'Working...',
    tools: 'tools',
  },
};
