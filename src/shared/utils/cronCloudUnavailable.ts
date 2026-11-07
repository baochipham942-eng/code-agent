// 云端调度器不可用的两句固定报文（N-CRON-FAIL-PLAIN-CLOUD-DOWN）。
// cronService 构造 CronCloudRuntime 时按界面语言选一句；失败分类靠「文本里含不含
// 这两句」识别 cloud_unavailable。句子本身是唯一判据——改字必须连着分类与测试一起动。

export const CRON_CLOUD_UNAVAILABLE_MESSAGE_EN =
  'The cloud scheduler is unavailable, so the job was not run. Check the cloud scheduler URL and token, then try again.';

export const CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH =
  '云端计划任务服务暂时不可用，任务未执行。请检查云端执行地址和令牌后重试。';

/** 文本里出现任一固定句即视为云端调度器不可用；cause 报文追加在后面也不影响识别。 */
export function isCronCloudUnavailableError(text: string): boolean {
  return text.includes(CRON_CLOUD_UNAVAILABLE_MESSAGE_EN)
    || text.includes(CRON_CLOUD_UNAVAILABLE_MESSAGE_ZH);
}
