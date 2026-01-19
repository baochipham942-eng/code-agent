// ============================================================================
// useI18n Hook - 国际化 Hook（支持云端配置）
// ============================================================================

import { useCallback, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { languages, type Language, type Translations } from '../i18n';

/**
 * 国际化 Hook
 * 提供当前语言的翻译文本和语言切换功能
 * 支持从云端获取动态 UI 字符串
 */
export function useI18n() {
  const { language, setLanguage, cloudUIStrings } = useAppStore();

  // 获取当前语言的翻译（内置）
  const builtinT: Translations = languages[language];

  // 合并云端字符串（如果有）
  // 云端字符串是扁平的 key-value 格式，用于覆盖特定文本
  const cloudStrings = useMemo(() => {
    return cloudUIStrings?.[language] || {};
  }, [cloudUIStrings, language]);

  // 获取云端字符串的函数
  const getCloudString = useCallback(
    (key: string, fallback?: string): string => {
      return cloudStrings[key] || fallback || key;
    },
    [cloudStrings]
  );

  // 切换语言
  const switchLanguage = useCallback(
    (lang: Language) => {
      setLanguage(lang);
    },
    [setLanguage]
  );

  // 获取所有可用语言
  const availableLanguages: { code: Language; name: string; native: string }[] = [
    { code: 'zh', name: builtinT.language.options.zh.name, native: builtinT.language.options.zh.native },
    { code: 'en', name: builtinT.language.options.en.name, native: builtinT.language.options.en.native },
  ];

  return {
    t: builtinT,
    language,
    setLanguage: switchLanguage,
    availableLanguages,
    // 云端字符串支持
    getCloudString,
    cloudStrings,
  };
}

export type { Language, Translations };
