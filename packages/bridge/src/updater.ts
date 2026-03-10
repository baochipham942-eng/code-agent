import type { HealthResponse } from './types';

const RELEASE_REPO = process.env.CODE_AGENT_BRIDGE_RELEASE_REPO ?? 'linchen/code-agent';
const DAY_MS = 24 * 60 * 60 * 1000;

function compareVersions(a: string, b: string): number {
  const strip = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pa = strip(a);
  const pb = strip(b);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export class Updater {
  private latestVersion: string | undefined;
  private lastCheckedAt = 0;

  constructor(private readonly currentVersion: string) {}

  async checkForUpdates(force = false): Promise<void> {
    if (!force && Date.now() - this.lastCheckedAt < DAY_MS) {
      return;
    }
    this.lastCheckedAt = Date.now();
    try {
      const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { 'user-agent': 'code-agent-bridge' },
      });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { tag_name?: string };
      if (payload.tag_name && compareVersions(payload.tag_name, this.currentVersion) > 0) {
        this.latestVersion = payload.tag_name;
      }
    } catch {
      // ignore updater failures
    }
  }

  attachHealth(health: HealthResponse): HealthResponse {
    if (this.latestVersion) {
      return { ...health, latestVersion: this.latestVersion };
    }
    return health;
  }
}
