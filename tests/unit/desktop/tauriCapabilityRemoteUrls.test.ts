// Tauri capability 的 remote.urls 必须覆盖**整个槽段**，不能手写单个端口（N-L7-ACL）。
//
// 为什么要有这道门：原来只列了 8180（生产）与 8181（Dev 槽 1）。NEO_SLOT 后来加出槽 2~9
// （端口 8182~8189），这份清单没人补 —— 槽≥2 的 renderer 成了未授权 remote，**所有** plugin
// 命令被 ACL 拒。真机表现是原生 AEC 起不来、静默降级耳机模式
// （`native-start-failed: Command plugin:event|listen not allowed by ACL`），
// 于是过去在槽≥2 上做的每一次「原生 AEC 验收」验的其实都是降级路径。
//
// 这是「按名字枚举的允许清单静默漏」的又一例：清单本身没错，错在它与真源
// （devSlot.ts 的 PROD_WEB_PORT / MAX_DEV_SLOT）之间没有对账。本测试就是那道对账。

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_DEV_SLOT, PROD_WEB_PORT, devSlotWebPort } from '../../../src/shared/devSlot';

const CAPABILITY_PATH = path.join(process.cwd(), 'src-tauri/capabilities/default.json');

interface Capability {
  remote?: { urls?: string[] };
  windows?: string[];
}

function readCapability(): Capability {
  return JSON.parse(fs.readFileSync(CAPABILITY_PATH, 'utf8')) as Capability;
}

/** 生产端口 + 槽 1..MAX_DEV_SLOT，全部按 devSlot.ts 派生，不在本文件里写死任何端口。 */
function expectedRemoteUrls(): string[] {
  const ports = [PROD_WEB_PORT];
  for (let slot = 1; slot <= MAX_DEV_SLOT; slot += 1) ports.push(devSlotWebPort(slot));
  return ports.map((port) => `http://localhost:${port}/*`);
}

describe('tauri default capability remote.urls', () => {
  it('覆盖整个槽段：生产端口 + 每一个 dev 槽，一个不多一个不少', () => {
    const urls = readCapability().remote?.urls ?? [];
    expect(urls).toEqual(expectedRemoteUrls());
  });

  it('槽段两端都在（改大 MAX_DEV_SLOT 而不补清单时这条先红）', () => {
    const urls = readCapability().remote?.urls ?? [];
    expect(urls).toContain(`http://localhost:${devSlotWebPort(1)}/*`);
    expect(urls).toContain(`http://localhost:${devSlotWebPort(MAX_DEV_SLOT)}/*`);
    // 段外端口不许出现：清单只授权本产品的槽段，不给隔壁进程搭便车。
    expect(urls).not.toContain(`http://localhost:${devSlotWebPort(MAX_DEV_SLOT) + 1}/*`);
  });

  it('不允许用通配端口绕过这道门（那等于把整个 localhost 授权出去）', () => {
    const urls = readCapability().remote?.urls ?? [];
    for (const url of urls) {
      expect(url, `remote.urls 里出现通配端口：${url}`).toMatch(/^http:\/\/localhost:\d{4,5}\/\*$/);
    }
  });
});
