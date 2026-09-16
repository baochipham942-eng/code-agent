import { describe, expect, it } from 'vitest';
import { adoptEndpoint } from '../../../packages/mobile/src/platform/lanCompanionClient';

/**
 * 地址自愈的采纳规则（N-COMPANION-NOLANPORT）。承重点是**不对称**的：
 * 宿主报的地址只有在形状合法时才采纳，否则退回这次真拨通的那个——
 * 此刻通着的地址永远比一个校验不过的新地址可信。盲目采纳的后果是把唯一能用的路也换掉。
 */
describe('adoptEndpoint：宿主报的地址优先，但必须过校验', () => {
  const dialed = 'http://192.168.1.7:8182';

  it('合法的私网字面量：采纳（这就是自愈本身）', () => {
    expect(adoptEndpoint('http://172.20.10.6:8182', dialed)).toBe('http://172.20.10.6:8182');
  });

  it('合法的 mDNS 名：同样采纳', () => {
    expect(adoptEndpoint('http://imac.local:8182', dialed)).toBe('http://imac.local:8182');
  });

  it('宿主没报：留住手里那个', () => {
    for (const nothing of [undefined, null, '', 0, false, {}]) {
      expect(adoptEndpoint(nothing, dialed)).toBe(dialed);
    }
  });

  it.each([
    ['公网地址', 'http://8.8.8.8:8182'],
    ['回环地址', 'http://127.0.0.1:8182'],
    ['https', 'https://192.168.1.9:8182'],
    ['带路径', 'http://192.168.1.9:8182/x'],
    ['带查询串', 'http://192.168.1.9:8182/?a=1'],
    ['带凭据', 'http://a:b@192.168.1.9:8182'],
    ['没有端口', 'http://192.168.1.9'],
    ['压根不是 URL', 'not-a-url'],
  ])('%s：不采纳，退回拨通的那个（不能因为对面报了坏值就把能用的地址丢掉）', (_label, reported) => {
    expect(adoptEndpoint(reported, dialed)).toBe(dialed);
  });
});
