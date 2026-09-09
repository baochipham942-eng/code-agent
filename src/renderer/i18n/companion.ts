export const companionText = {
  zh: {
    title: '连接手机', description: '手机和电脑连接同一网络，在手机 Neo 中扫描二维码。电脑需要保持开启。',
    scope: '允许手机访问的会话', create: '生成配对二维码', refresh: '刷新', empty: '先创建一个会话，再连接手机。',
    qr: 'Neo 手机配对二维码', expires: '二维码两分钟内有效，配对成功后失效。', expired: '二维码已过期，请重新生成。',
    devices: '已配对手机', revoke: '撤销连接', error: '连接设置暂不可用，请确认电脑已连接局域网后重试。',
    phone: '手机', working: '正在处理',
  },
  en: {
    title: 'Connect a phone', description: 'Connect both devices to the same network and scan this code in Neo on your phone. Keep this computer on.',
    scope: 'Conversations this phone can access', create: 'Create pairing code', refresh: 'Refresh', empty: 'Create a conversation before connecting your phone.',
    qr: 'Neo phone pairing code', expires: 'Valid for two minutes and one pairing.', expired: 'Code expired. Create a new code.',
    devices: 'Paired phones', revoke: 'Revoke connection', error: 'Connection settings unavailable. Check the local network and retry.',
    phone: 'Phone', working: 'Working',
  },
};
