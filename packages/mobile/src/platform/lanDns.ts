import { registerPlugin } from '@capacitor/core';

export interface LanDnsPluginPort {
  /** One-shot mDNS A-record resolve. `address` is null when it cannot resolve in time. */
  resolve(options: { host: string; timeoutMs: number }): Promise<{ address: string | null }>;
}

/**
 * 第一方 mDNS 单次解析桥（fix4-⑤）。原生实现两侧都是一次解析、带超时、不长驻 browse：
 * iOS 用 getaddrinfo（mDNSResponder/Bonjour，ios-native/NeoLanDnsPlugin.swift），
 * Android 的 Java 解析器不认 .local，由 build 脚本生成的 LanDnsPlugin.java 发一次
 * mDNS A 查询到 224.0.0.251:5353。web 宿主没有 mDNS，恒回 null——调用方回退旧地址。
 */
export const LanDns = registerPlugin<LanDnsPluginPort>('LanDns', {
  web: async () => ({ resolve: async () => ({ address: null }) }),
});
