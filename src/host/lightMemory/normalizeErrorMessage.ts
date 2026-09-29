import { LEARNING_PIPELINE } from '../../shared/constants';

/** 数字→N、引号内容→"..."、截断。失败日志和 runaway guard 共用这一套。 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\d+/g, 'N')
    .replace(/['"][^'"]*['"]/g, '"..."')
    .substring(0, LEARNING_PIPELINE.ERROR_PATTERN_MAX_CHARS);
}
