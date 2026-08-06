import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSlotConfig } from '../../scripts/gen-dev-slot-conf.ts';
import { devSlotWebPort, MAX_DEV_SLOT } from '../../src/shared/devSlot.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function template(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repoRoot, 'src-tauri/tauri.dev.conf.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('gen-dev-slot-conf', () => {
  it('leaves the committed template untouched for slot 1', () => {
    // 模板 = 槽 1 的成品。生成器对槽 1 必须是恒等变换，否则历史默认包会悄悄换身份。
    expect(buildSlotConfig(template(), 1)).toEqual(template());
  });

  it('rewrites identity and CSP port for a higher slot', () => {
    const config = buildSlotConfig(template(), 2) as {
      productName: string;
      identifier: string;
      app: { security: { csp: string } };
      bundle: unknown;
    };
    expect(config.productName).toBe('Agent Neo Dev 2');
    expect(config.identifier).toBe('com.linchen.code-agent.dev2');
    expect(config.app.security.csp).toContain('localhost:8182');
    // 旧端口一处都不能剩：CSP 里漏一条就是那类请求被拦，表现成局部功能坏掉而不是白屏。
    expect(config.app.security.csp).not.toContain('localhost:8181');
    // 资源声明必须原样保留——它是相对路径，生成文件与模板同目录才成立。
    expect(config.bundle).toEqual((template() as { bundle: unknown }).bundle);
  });

  it('keeps every slot on its own port in the generated CSP', () => {
    for (let slot = 1; slot <= MAX_DEV_SLOT; slot += 1) {
      const config = buildSlotConfig(template(), slot) as { app: { security: { csp: string } } };
      expect(config.app.security.csp).toContain(`localhost:${devSlotWebPort(slot)}`);
    }
  });

  it('fails loudly when the template CSP no longer carries the slot-1 port', () => {
    // 静默生成一份 CSP 指向别的端口的配置 = 打出来的包白屏，且看不出跟这里有关。
    const broken = { ...template(), app: { security: { csp: "default-src 'self'" } } };
    expect(() => buildSlotConfig(broken, 2)).toThrow(/csp/i);
  });
});
