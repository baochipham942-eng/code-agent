// ============================================================================
// ssrfGuard — 自定义端点 base URL + 裸下载 URL 的 SSRF 守卫
//
// 自定义生图模型端点借鉴项①：用户填自己的 OpenAI 兼容 base URL，须挡私网/环回/
// 链路本地/元数据地址，杜绝把主进程当跳板打内网。裸 downloadFile 入口（任意 URL
// fetch）一并纳入守卫（艾克斯审计修订 2）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  isPrivateOrLocalHost,
  assertSafeCustomBaseUrl,
  assertSafeDownloadUrl,
} from '../../../src/host/security/ssrfGuard';

describe('isPrivateOrLocalHost', () => {
  it('私网/环回/链路本地/元数据 IPv4 判为私有', () => {
    expect(isPrivateOrLocalHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('10.0.0.5')).toBe(true);
    expect(isPrivateOrLocalHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrLocalHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrLocalHost('192.168.1.10')).toBe(true);
    expect(isPrivateOrLocalHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrLocalHost('0.0.0.0')).toBe(true);
    expect(isPrivateOrLocalHost('localhost')).toBe(true);
  });
  it('云元数据主机名判为私有', () => {
    expect(isPrivateOrLocalHost('metadata.google.internal')).toBe(true);
    expect(isPrivateOrLocalHost('metadata')).toBe(true);
    expect(isPrivateOrLocalHost('instance-data')).toBe(true);
  });
  it('原 httpRequest BLOCKED_HOSTS 的元数据条目全部仍判私有（rework r1 基线对齐）', () => {
    expect(isPrivateOrLocalHost('100.100.100.200')).toBe(true); // Alibaba Cloud ECS metadata
    expect(isPrivateOrLocalHost('metadata.azure.com')).toBe(true); // Azure IMDS 主机名形式
    expect(isPrivateOrLocalHost('fd00:ec2::254')).toBe(true); // AWS IPv6 实例元数据（fd 前缀已覆盖）
    expect(isPrivateOrLocalHost('169.254.169.254')).toBe(true);
  });
  it('100.64.0.0/10 CGNAT 其余地址不在拦截范围（父单已记录的已知边界）', () => {
    expect(isPrivateOrLocalHost('100.64.0.1')).toBe(false);
    expect(isPrivateOrLocalHost('100.101.0.1')).toBe(false);
  });
  it('公网 IPv4 / 域名判为非私有', () => {
    expect(isPrivateOrLocalHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalHost('172.32.0.1')).toBe(false); // 172.32 出私网段
    expect(isPrivateOrLocalHost('api.openai.com')).toBe(false);
    expect(isPrivateOrLocalHost('dashscope-result.oss-cn.aliyuncs.com')).toBe(false);
  });
  it('localhost 变体（FQDN 尾点 / *.localhost 子域）判为私有（N-WEBFETCH-BLOCK-PRIVATE-NET）', () => {
    expect(isPrivateOrLocalHost('localhost.')).toBe(true); // WHATWG URL 保留尾点
    expect(isPrivateOrLocalHost('foo.localhost')).toBe(true); // RFC 6761/6762 解析到环回
    expect(isPrivateOrLocalHost('BAR.localhost')).toBe(true); // 大小写归一后命中
    expect(isPrivateOrLocalHost('example.com.')).toBe(false); // 公网域名的 FQDN 尾点形式仍放行
  });
  it('IPv6 环回/ULA/链路本地判为私有（含方括号字面量）', () => {
    expect(isPrivateOrLocalHost('[::1]')).toBe(true);
    expect(isPrivateOrLocalHost('::1')).toBe(true);
    expect(isPrivateOrLocalHost('[fc00::1]')).toBe(true);
    expect(isPrivateOrLocalHost('[fe80::1]')).toBe(true);
    expect(isPrivateOrLocalHost('[::ffff:192.168.0.1]')).toBe(true);
  });
});

describe('assertSafeCustomBaseUrl', () => {
  it('放行 https 公网并返回去尾斜杠的规范化 URL', () => {
    expect(assertSafeCustomBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(assertSafeCustomBaseUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1');
    expect(assertSafeCustomBaseUrl('  https://api.x.com  ')).toBe('https://api.x.com');
  });
  it('拒绝非 https（含 http）', () => {
    expect(() => assertSafeCustomBaseUrl('http://api.x.com')).toThrow();
  });
  it('拒绝私网/环回/元数据地址', () => {
    expect(() => assertSafeCustomBaseUrl('https://127.0.0.1/v1')).toThrow();
    expect(() => assertSafeCustomBaseUrl('https://localhost/v1')).toThrow();
    expect(() => assertSafeCustomBaseUrl('https://192.168.1.1/v1')).toThrow();
    expect(() => assertSafeCustomBaseUrl('https://169.254.169.254/')).toThrow();
    expect(() => assertSafeCustomBaseUrl('https://[::1]/v1')).toThrow();
  });
  it('拒绝非法 URL 与空串', () => {
    expect(() => assertSafeCustomBaseUrl('not a url')).toThrow();
    expect(() => assertSafeCustomBaseUrl('')).toThrow();
  });
  it('拒绝内嵌凭证（userinfo），防凭证随 URL 外泄到端点日志', () => {
    expect(() => assertSafeCustomBaseUrl('https://user:pass@api.x.com/v1')).toThrow();
    expect(() => assertSafeCustomBaseUrl('https://user@api.x.com/v1')).toThrow();
  });
  it('返回 WHATWG 规范化形式（host 小写）以便去重一致', () => {
    expect(assertSafeCustomBaseUrl('HTTPS://API.X.COM/v1')).toBe('https://api.x.com/v1');
  });
});

describe('assertSafeDownloadUrl', () => {
  it('放行 https 与 http 公网（下载比出图宽松，允许 http）', () => {
    expect(() => assertSafeDownloadUrl('https://oss.example.com/a.png')).not.toThrow();
    expect(() => assertSafeDownloadUrl('http://example.com/a.png')).not.toThrow();
  });
  it('拒绝私网/环回/元数据', () => {
    expect(() => assertSafeDownloadUrl('https://127.0.0.1/x')).toThrow();
    expect(() => assertSafeDownloadUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertSafeDownloadUrl('http://192.168.0.1/x')).toThrow();
  });
  it('拒绝非 http(s) 协议（file/ftp 等）', () => {
    expect(() => assertSafeDownloadUrl('file:///etc/passwd')).toThrow();
    expect(() => assertSafeDownloadUrl('ftp://example.com/x')).toThrow();
  });
});
