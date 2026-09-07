// ============================================================================
// useI18n Hook - 国际化 Hook（支持云端配置）
// ============================================================================

import { useCallback, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { languages, type Language, type Translations } from '../i18n';

/** 把嵌套文案树拍平成点分路径集合（数组/原始值是叶子，不展开 index）。 */
function flattenTranslationKeys(node: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>();
  if (!node || typeof node !== 'object' || Array.isArray(node)) return keys;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flattenTranslationKeys(value, path)) keys.add(nested);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

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

  // 云端 kv 的 key 不在内置文案树里 = 配置错位/过期（永远没有消费方）。静默吞掉排查时
  // 看不见，这里 warn 一声留痕（降级留痕规则）；开发者日志，不弹窗、不拦渲染。
  const builtinKeySet = useMemo(() => flattenTranslationKeys(builtinT), [builtinT]);
  useEffect(() => {
    const unknownKeys = Object.keys(cloudStrings).filter((key) => !builtinKeySet.has(key));
    if (unknownKeys.length > 0) {
      console.warn(
        `[i18n] 云端 UI 字符串的 key 不在内置文案树里（${language}）: ${unknownKeys.join(', ')}`,
      );
    }
  }, [cloudStrings, builtinKeySet, language]);

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
