import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSlotInPool, buildSlotConfig, knownDevSlots } from '../../scripts/gen-dev-slot-conf.ts';
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

describe('dev 槽池护栏', () => {
  const present = (...names: string[]) => (p: string) => names.some((name) => p.endsWith(`/${name}`));
  const HOME = '/home/tester';

  it('已装 app 与存在的数据目录取并集', () => {
    expect(knownDevSlots(HOME, '/Applications', present(
      'Agent Neo Dev.app', // 槽 1：只有 app
      '.code-agent-dev3', // 槽 3：只有数据目录
    ))).toEqual([1, 3]);
  });

  it('数据目录被抹掉、app 还在 → 仍在池里', () => {
    // 承重点：抹数据目录是拿干净状态的正确做法，它不能让这个槽变回「新槽」，
    // 否则每清一次就逼人扩池一次，正好复现 2026-08-08 那次多余的授权。
    expect(knownDevSlots(HOME, '/Applications', present('Agent Neo Dev 2.app'))).toEqual([2]);
  });

  it('app 卸了、数据目录还在 → 仍在池里', () => {
    // TCC 记录按 bundle id 留在系统里，重装不用重新授权，所以这也不是新槽。
    expect(knownDevSlots(HOME, '/Applications', present('.code-agent-dev2'))).toEqual([2]);
  });

  it('两条痕迹都没有才算没见过', () => {
    expect(knownDevSlots(HOME, '/Applications', () => false)).toEqual([]);
  });

  it('复用池内已装的槽直接放行', () => {
    expect(() => assertSlotInPool(2, [1, 2, 3], false)).not.toThrow();
  });

  it('池非空时请求未安装的新槽报红，并把可复用的槽和抹数据目录的命令说出来', () => {
    expect(() => assertSlotInPool(4, [1, 2, 3], false)).toThrow(/NEO_SLOT=4/);
    expect(() => assertSlotInPool(4, [1, 2, 3], false)).toThrow(/rm -rf ~\/\.code-agent-dev2/);
    expect(() => assertSlotInPool(4, [1, 2, 3], false)).toThrow(/NEO_SLOT_NEW=1/);
  });

  it('显式声明扩池时放行', () => {
    expect(() => assertSlotInPool(4, [1, 2, 3], true)).not.toThrow();
  });

  it('全新机器（池为空）放行，不挡住第一次构建', () => {
    expect(() => assertSlotInPool(1, [], false)).not.toThrow();
    expect(() => assertSlotInPool(5, [], false)).not.toThrow();
  });
});
