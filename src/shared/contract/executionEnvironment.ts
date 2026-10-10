// ADR-081 执行环境成为一等对象：逐轮选择契约与协议版本闸的稳定常量。
// 本文件只放合同形状；版本闸的判定逻辑在 web 路由侧（environmentProtocolGate.ts）。

/** 一轮开始时账本追加的执行环境选择（ADR-081「逐轮选择的契约」）。 */
export interface TurnEnvironmentSelection {
  environmentId: string;
  cwd: string;
  workspaceRoots: string[];
  config: {
    internet: 'deny' | { allowDomains: string[] };
    credentialPlaceholders: Array<{
      placeholderId: string;
      connectorId: string;
      destination: string;
    }>;
  };
}

/** 携带 environmentSelection 的消息必须带的协议版本（ADR-081「协议版本闸」）。 */
export const ENVIRONMENT_SELECTION_PROTOCOL_VERSION = 'environment-selection/1';

/** 版本闸拒绝时宿主回给客户端的唯一稳定码；人话文案在渲染端 i18n。 */
export const ENVIRONMENT_PROTOCOL_UNSUPPORTED = 'ENVIRONMENT_PROTOCOL_UNSUPPORTED';
