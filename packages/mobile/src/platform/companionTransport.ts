import { COMPANION_LIMITS } from '../../../../src/shared/constants/companion';

export type CompanionConfig = {
  baseUrl: string;
  deviceId: string;
  credential: string;
  scopeEpoch: number;
};

export class CompanionTransport {
  constructor(private readonly readConfig: () => Promise<CompanionConfig | null>) {}

  // The caller must persist this ID with the draft before the first attempt.
  async sendMessage(text: string, sessionId: string, commandId: string): Promise<{ state: 'accepted' | 'resolved' | 'reconciling' }> {
    const config = await this.readConfig();
    if (!config) throw new Error('COMPANION_NOT_PAIRED');
    if (!sessionId.trim() || !commandId.trim() || !text.trim() || text.length > COMPANION_LIMITS.messageLength) throw new Error('COMPANION_INVALID_COMMAND');
    const target = new URL(config.baseUrl);
    // Until the encrypted relay adapter lands this transport is local-only.
    // Neither a random HTTPS server nor a private LAN is an E2EE substitute.
    if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash) {
      throw new Error('COMPANION_SECURE_CHANNEL_REQUIRED');
    }
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/companion/commands`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(COMPANION_LIMITS.requestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-neo-companion-device': config.deviceId,
        'x-neo-companion-credential': config.credential,
      },
      body: JSON.stringify({
        version: 1,
        commandId,
        deviceId: config.deviceId,
        scopeEpoch: config.scopeEpoch,
        sessionId,
        action: 'message.send',
        payload: { text },
      }),
    });
    if (!response.ok) throw new Error(`COMPANION_HTTP_${response.status}`);
    const body = await response.json();
    const command = body?.data?.command;
    if (body?.success !== true || !['accepted', 'replayed'].includes(body?.data?.kind) ||
        command?.commandId !== commandId || command?.deviceId !== config.deviceId || command?.sessionId !== sessionId || command?.action !== 'message.send') {
      throw new Error('COMPANION_INVALID_ACK');
    }
    if (command.state === 'rejected' || command.state === 'conflict') throw new Error('COMPANION_COMMAND_REJECTED');
    if (!['accepted', 'resolved', 'reconciling'].includes(command.state)) throw new Error('COMPANION_INVALID_ACK');
    return { state: command.state };
  }
}
