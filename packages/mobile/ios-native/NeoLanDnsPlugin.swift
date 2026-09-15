import Capacitor
import Foundation

/// 第一方 mDNS 单次解析（fix4-⑤，2026-09-15）：重连前把绑定里的 `主机名.local` 重新解析成
/// 当前 IPv4，治「电脑换网后手机死磕旧 IP」。
///
/// 为什么自己写而不是靠 HTTP 层：CapacitorHttp/URLSession 对 `.local` 的解析在
/// 「手机开热点、电脑连它」的拓扑下不可达（2026-09-12 真机实测）；`getaddrinfo` 走
/// mDNSResponder（Bonjour）做单播解析，是系统里可靠的入口。一次解析、带超时、不长驻
/// browse——与 Android 侧 LanDnsPlugin（一次 mDNS A 查询）能力对齐。
@objc(NeoLanDnsPlugin)
public class NeoLanDnsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NeoLanDnsPlugin"
    public let jsName = "LanDns"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "resolve", returnType: CAPPluginReturnPromise)
    ]

    /// getaddrinfo 阻塞且没有取消口。并发上限=1：`queue` 是串行队列，第二次 resolve 会
    /// 排到第一次（连同它的超时等待）结束才开始，超时后遗留的那一条 getaddrinfo 由系统
    /// 自己收（mDNS 解析自带秒级内部超时），不会堆积成池。兜底 3000 与
    /// COMPANION_LIMITS.mdnsResolveTimeoutMs 同源——JS 侧每次都会显式传参。
    private static let fallbackTimeoutMs = 3_000
    private let queue = DispatchQueue(label: "ai.neo.companion.lan-dns")

    @objc func resolve(_ call: CAPPluginCall) {
        // 与 Android 侧 LanDnsPlugin 同一口径：只接 .local 主机名（JS 层已滤过，这里再守一道）。
        guard let host = call.getString("host"), host.lowercased().hasSuffix(".local"), !host.isEmpty else {
            call.reject("INVALID_HOST")
            return
        }
        let timeoutMs = call.getInt("timeoutMs") ?? Self.fallbackTimeoutMs
        let timeout = Double(max(250, timeoutMs)) / 1000
        queue.async {
            let semaphore = DispatchSemaphore(value: 0)
            var address: String?
            DispatchQueue.global(qos: .userInitiated).async {
                defer { semaphore.signal() }
                address = Self.resolveIpv4(host)
            }
            let timedOut = semaphore.wait(timeout: .now() + timeout) == .timedOut
            // 解析不出/超时都不是错误：回 address=null，调用方回退绑定里的旧地址。
            call.resolve(["address": (timedOut ? nil : address) ?? NSNull()])
        }
    }

    /// AF_INET only：LAN 同伴只有 IPv4（端点校验也只认私网 IPv4 字面量）。
    private static func resolveIpv4(_ host: String) -> String? {
        var hints = addrinfo()
        hints.ai_family = AF_INET
        hints.ai_socktype = SOCK_STREAM
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else { return nil }
        defer { freeaddrinfo(result) }
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let current = cursor {
            if let sa = current.pointee.ai_addr, current.pointee.ai_family == AF_INET,
               let text = Self.describe(sa) {
                return text
            }
            cursor = current.pointee.ai_next
        }
        return nil
    }

    private static func describe(_ sa: UnsafeMutablePointer<sockaddr>) -> String? {
        sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { inet in
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            guard inet_ntop(AF_INET, &inet.pointee.sin_addr, &buffer, socklen_t(INET_ADDRSTRLEN)) != nil else { return nil }
            return String(cString: buffer)
        }
    }
}
