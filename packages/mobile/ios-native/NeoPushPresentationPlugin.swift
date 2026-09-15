import Capacitor
import Foundation
import UserNotifications

/// 前台推送要不要弹，交给 JS 判（N-MOBILE-EXEC-STATUS ④，2026-09-15）。
///
/// Capacitor 的推送插件在前台一律按 capacitor.config 的 presentationOptions 弹横幅，没有按条判断的口子：
/// 用户正看着那条会话时，任务完成/失败已经在会话里就地出现，系统横幅是重复打扰。这里把
/// UNUserNotificationCenter 的 delegate 换成自己，前台来远程推送时先发 `willPresent` 给 JS，
/// JS 用 `decide` 回话：present=true 就原样交还 Capacitor 的 NotificationRouter（推送插件照旧收到
/// pushNotificationReceived、按配置弹），false 就不弹。
///
/// 兜底一律是「照常弹」：JS 没订阅、判定超时、不是远程推送，都原样走 Capacitor——
/// 宁可多弹一次，也不许把别的会话的提醒吞掉。点按（didReceive）永远原样转交，不经 JS。
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
    private var waiting: [String: (Bool) -> Void] = [:]

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
        let present = call.getBool("present") ?? true
        DispatchQueue.main.async {
            self.finish(id, present: present)
            call.resolve()
        }
    }

    private func finish(_ id: String, present: Bool) {
        guard let resume = waiting.removeValue(forKey: id) else { return }
        resume(present)
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
            self.waiting[id] = { present in
                if present {
                    router.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
                } else {
                    completionHandler([])
                }
            }
            self.notifyListeners("willPresent", data: ["id": id, "routeToken": routeToken])
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.decisionTimeout) {
                self.finish(id, present: true)
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
