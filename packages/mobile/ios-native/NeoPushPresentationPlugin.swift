import Capacitor
import Foundation
import UserNotifications

/// 前台推送怎么呈现，交给 JS 判（N-MOBILE-EXEC-STATUS ④，2026-09-15；N-MOBILE-FOREGROUND-PUSH-R3）。
///
/// Capacitor 的推送插件在前台一律按 capacitor.config 的 presentationOptions 弹横幅，没有按条判断的口子。
/// 这里把 UNUserNotificationCenter 的 delegate 换成自己，前台来远程推送时先发 `willPresent` 给 JS，
/// JS 用 `decide` 回话两位：
/// - present：要不要弹横幅。常态是 false——前台不打扰，app 内轻提示+未读点替位（R2 起的拍板）。
/// - list：要不要落通知中心列表。常态是 true——app 内轻提示是单槽内存态（下一条一顶、杀 app 即没），
///   判不出归属/断网的推送不能只剩一条闪一下就没的提示；通知中心那份才是持久、可堆叠、点得动的记录
///   （R3 Important：R2 恒 present=false 时这里跟着投了空 options，系统层零痕迹，第一条推送被第二条
///   顶掉后永久不可达）。
/// 两位全 false 只属于「正看着的就是推送那条会话」：任务完成/失败、待确认都已在会话里就地出现，
/// 横幅和列表记录都是重复打扰（present=true 时原样交还 Capacitor 的 NotificationRouter，推送插件
/// 照旧收到 pushNotificationReceived、按配置弹）。
///
/// 兜底一律是「照常弹」：JS 没订阅、判定超时、不是远程推送，都原样走 Capacitor——
/// 宁可多弹一次，也不许把别的会话的提醒吞掉。decide 里两个字段缺省也是 true（JS/原生版本错配、
/// 字段没送到时宁留痕不吞）。点按（didReceive）永远原样转交，不经 JS。
@objc(NeoPushPresentationPlugin)
public class NeoPushPresentationPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    public let identifier = "NeoPushPresentationPlugin"
    public let jsName = "PushPresentation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decide", returnType: CAPPluginReturnPromise)
    ]

    /// JS 要先向电脑查一次这条推送属于哪条会话（一次 LAN 往返）：给够时间，但别让横幅迟到太久。
    private static let decisionTimeout: TimeInterval = 1.5
    /// 只在主线程读写：willPresent、decide、超时三处都先切到主线程。
    private var waiting: [String: (Bool, Bool) -> Void] = [:]

    @objc func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.bridge != nil else {
                call.reject("BRIDGE_UNAVAILABLE")
                return
            }
            UNUserNotificationCenter.current().delegate = self
            call.resolve()
        }
    }

    @objc func decide(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("ID_REQUIRED")
            return
        }
        // 两位缺省 true：字段没送到（JS/原生版本错配）按「宁留痕不吞」结算。
        let present = call.getBool("present") ?? true
        let list = call.getBool("list") ?? true
        DispatchQueue.main.async {
            self.finish(id, present: present, list: list)
            call.resolve()
        }
    }

    private func finish(_ id: String, present: Bool, list: Bool) {
        guard let resume = waiting.removeValue(forKey: id) else { return }
        resume(present, list)
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard let router = bridge?.notificationRouter else {
            completionHandler([.banner, .list, .sound, .badge])
            return
        }
        let isRemote = notification.request.trigger?.isKind(of: UNPushNotificationTrigger.self) == true
        guard isRemote, hasListeners("willPresent") else {
            router.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
            return
        }
        let routeToken = notification.request.content.userInfo["routeToken"] as? String ?? ""
        DispatchQueue.main.async {
            let id = UUID().uuidString
            self.waiting[id] = { present, list in
                if present {
                    router.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
                } else if list {
                    // 不弹横幅，但落通知中心：app 内轻提示是单槽内存态，判不出归属的推送只有这里留得下
                    // 持久、不被下一条顶掉的记录（N-MOBILE-FOREGROUND-PUSH-R3 Important）。
                    completionHandler([.list])
                } else {
                    completionHandler([])
                }
            }
            self.notifyListeners("willPresent", data: ["id": id, "routeToken": routeToken])
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.decisionTimeout) {
                self.finish(id, present: true, list: true)
            }
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let router = bridge?.notificationRouter else {
            completionHandler()
            return
        }
        router.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
    }
}
