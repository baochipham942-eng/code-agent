// Comparator Module - A/B comparison between baseline and candidate configurations
export { ABComparator } from './comparator';
export { ABGrader } from './abGrader';
export type { GradeOutput, GradeResult } from './abGrader';
export { generateComparisonMarkdown, generateComparisonConsole } from './comparisonReport';
export { loadCompareConfig } from './configLoader';
export { runCompare, assertCompareArmsDistinct, assertCompareArmsActivated } from './runCompare';
export type { RunCompareOptions } from './runCompare';
