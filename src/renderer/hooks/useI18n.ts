// ============================================================================
// useI18n Hook - 国际化 Hook
// ============================================================================

import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { languages, type Language, type Translations } from '../i18n';

/**
 * 国际化 Hook
 * 提供当前语言的翻译文本和语言切换功能
 */
export function useI18n() {
  const { language, setLanguage } = useAppStore();

  // 获取当前语言的翻译
  const t: Translations = languages[language];

  // 切换语言
  const switchLanguage = useCallback(
    (lang: Language) => {
      setLanguage(lang);
    },
    [setLanguage]
  );

  // 获取所有可用语言
  const availableLanguages: { code: Language; name: string; native: string }[] = [
    { code: 'zh', name: t.language.options.zh.name, native: t.language.options.zh.native },
    { code: 'en', name: t.language.options.en.name, native: t.language.options.en.native },
  ];

  return {
    t,
    language,
    setLanguage: switchLanguage,
    availableLanguages,
  };
}

export type { Language, Translations };
