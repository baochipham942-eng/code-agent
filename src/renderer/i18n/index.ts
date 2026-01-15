// ============================================================================
// Internationalization (i18n) - 国际化
// ============================================================================

import { zh, type Translations } from './zh';
import { en } from './en';

export type Language = 'zh' | 'en';

export const languages: Record<Language, Translations> = {
  zh,
  en,
};

export const defaultLanguage: Language = 'zh';

export type { Translations };
export { zh, en };
