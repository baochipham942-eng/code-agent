import { CLI_CONNECTOR_DESCRIPTORS } from '@shared/constants/cliConnectorDescriptors';

/** 连接卡 / 续跑消息里的连接器名：原生状态的 label → CLI 描述符 displayName → id。 */
export function connectorDisplayName(connectorId: string, nativeStatuses: Array<{ id: string; label: string }> = []): string {
  return nativeStatuses.find((item) => item.id === connectorId)?.label
    || CLI_CONNECTOR_DESCRIPTORS.find((item) => item.id === connectorId)?.displayName
    || connectorId;
}
