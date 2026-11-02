// ============================================================================
// connectorRequired 域词条（聊天内「连接器未连接」连接卡，N-CONNECTOR-POLISH-AUDIT-FU1）
// —— zh/en 同文件相邻维护。continuation 是连接完成后自动追加的那条用户消息。
// ============================================================================

export const connectorRequiredZh = {
  connectorRequired: {
    title: '{name} 还没连接',
    body: '连接后会自动继续刚才的任务',
    connect: '去连接',
    later: '稍后',
    resuming: '{name} 已连接，正在继续',
    manual: '我已连好，继续',
    continuation: '{name} 已连接，请继续刚才的任务',
  },
};

export const connectorRequiredEn: typeof connectorRequiredZh = {
  connectorRequired: {
    title: '{name} is not connected yet',
    body: 'Once connected, the task continues automatically',
    connect: 'Connect',
    later: 'Later',
    resuming: '{name} is connected, continuing',
    manual: "I've connected it, continue",
    continuation: '{name} is connected, please continue the previous task',
  },
};
