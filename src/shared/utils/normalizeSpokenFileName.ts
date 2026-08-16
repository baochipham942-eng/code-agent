const SPOKEN_DIGIT_MAP: Readonly<Record<string, string>> = {
  '零': '0',
  '〇': '0',
  '一': '1',
  '壹': '1',
  '二': '2',
  '贰': '2',
  '三': '3',
  '叁': '3',
  '四': '4',
  '肆': '4',
  '五': '5',
  '伍': '5',
  '六': '6',
  '陆': '6',
  '七': '7',
  '柒': '7',
  '八': '8',
  '捌': '8',
  '九': '9',
  '玖': '9',
};

const COMMON_FILE_EXTENSIONS = [
  'md', 'txt', 'js', 'jsx', 'ts', 'tsx', 'json', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'csv',
  'html', 'htm', 'css', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'sh', 'yaml', 'yml',
] as const;

const SPOKEN_FILE_NAME_PATTERN = new RegExp(
  `([零〇一壹二贰三叁四肆五伍六陆七柒八捌九玖]+)点\\.?(${COMMON_FILE_EXTENSIONS.join('|')})(?![a-z0-9])`,
  'gi',
);

/**
 * Normalize only the narrow ASR pattern for digit-named files.
 * The transcript remains untouched in persistence; this helper is for display/task titles.
 */
export function normalizeSpokenFileName(text: string): string {
  return text.replace(SPOKEN_FILE_NAME_PATTERN, (_, spokenDigits: string, extension: string) => {
    const digits = Array.from(spokenDigits, (digit) => SPOKEN_DIGIT_MAP[digit] ?? digit).join('');
    return `${digits}.${extension.toLowerCase()}`;
  });
}
