/** 云端未配置的可区分错误：IPC 层据此回 CRON_CLOUD_NOT_CONFIGURED，渲染层给本地化引导。 */
export class CloudNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudNotConfiguredError';
  }
}
