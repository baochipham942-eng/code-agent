import { useSessionStore } from '../../../stores/sessionStore';

export function formatChannelSessionSource(
  session: ReturnType<typeof useSessionStore.getState>['sessions'][number] | undefined,
): string | null {
  if (session?.origin?.kind !== 'channel') return null;
  const metadata = session.origin.metadata || {};
  const channelType = typeof metadata.channelType === 'string'
    ? metadata.channelType
    : typeof metadata.channelId === 'string'
      ? metadata.channelId
      : 'channel';
  const platform = channelType === 'feishu'
    ? 'Feishu'
    : channelType === 'lark'
      ? 'Lark'
      : channelType === 'telegram'
        ? 'Telegram'
        : channelType;
  const accountName = typeof metadata.accountName === 'string' ? metadata.accountName : undefined;
  const chatName = typeof metadata.chatName === 'string'
    ? metadata.chatName
    : typeof metadata.chatId === 'string'
      ? metadata.chatId
      : session.origin.name;
  return [platform, accountName, chatName].filter(Boolean).join(' · ');
}
