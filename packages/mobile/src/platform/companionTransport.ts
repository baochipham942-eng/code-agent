export type CompanionConfig = {
  baseUrl: string;
  deviceId: string;
  credential: string;
  scopeEpoch: number;
};

export class CompanionTransport {
  constructor(private readonly readConfig: () => Promise<CompanionConfig | null>) {}

  async sendMessage(text: string, sessionId?: string): Promise<{ accepted: boolean }> {
    const config = await this.readConfig();
    if (!config) throw new Error('COMPANION_NOT_PAIRED');
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/companion/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-neo-companion-device': config.deviceId,
        'x-neo-companion-credential': config.credential,
      },
      body: JSON.stringify({
        version: 1,
        commandId: crypto.randomUUID(),
        deviceId: config.deviceId,
        scopeEpoch: config.scopeEpoch,
        sessionId,
        action: 'message.send',
        payload: { text },
      }),
    });
    if (!response.ok) throw new Error(`COMPANION_HTTP_${response.status}`);
    return { accepted: true };
  }
}
