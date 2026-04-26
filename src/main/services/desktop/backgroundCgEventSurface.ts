import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface BackgroundCgEventWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackgroundCgEventWindow {
  windowId: number;
  pid: number;
  appName: string;
  bundleId?: string | null;
  title?: string | null;
  bounds: BackgroundCgEventWindowBounds;
  layer?: number | null;
  alpha?: number | null;
  isOnScreen?: boolean | null;
  windowRef?: string;
  qualityScore?: number;
  qualityGrade?: 'recommended' | 'usable' | 'low';
  qualityReasons?: string[];
  recommended?: boolean;
}

export interface BackgroundCgEventWindowPoint {
  x: number;
  y: number;
}

export interface BackgroundCgEventClickRequest {
  pid?: number;
  windowId?: number;
  windowRef?: string;
  targetApp?: string;
  bundleId?: string;
  title?: string;
  windowLocalPoint: BackgroundCgEventWindowPoint;
  button?: 'left' | 'right';
  clickCount?: number;
  timeoutMs?: number;
}

export interface BackgroundCgEventTargetVerification {
  ok: boolean;
  stale: boolean;
  checkedAtMs: number;
  expected: {
    pid?: number;
    windowId?: number;
    windowRef?: string | null;
    targetApp?: string | null;
    bundleId?: string | null;
    title?: string | null;
  };
  currentWindow?: BackgroundCgEventWindow | null;
  mismatches: string[];
  warnings: string[];
}

export interface BackgroundCgEventClickResult {
  pid: number;
  windowId: number;
  windowRef?: string;
  appName: string;
  bundleId?: string | null;
  title?: string | null;
  bounds: BackgroundCgEventWindowBounds;
  windowLocalPoint: BackgroundCgEventWindowPoint;
  screenPoint: BackgroundCgEventWindowPoint;
  button: 'left' | 'right';
  clickCount: number;
  isTargetActive: boolean;
  usedWindowLocation: boolean;
  eventNumbers?: number[];
  targetVerification?: BackgroundCgEventTargetVerification;
}

export interface ListBackgroundCgEventWindowsOptions {
  targetApp?: string;
  bundleId?: string;
  title?: string;
  pid?: number;
  windowId?: number;
  limit?: number;
  timeoutMs?: number;
}

export interface BackgroundCgEventAppDiagnosis {
  targetApp?: string | null;
  capturedAtMs: number;
  platform: NodeJS.Platform;
  helper: {
    available: boolean;
    path?: string | null;
    error?: string | null;
  };
  os: {
    version?: string | null;
  };
  permissions: {
    accessibilityTrusted?: boolean | null;
    screenRecordingGranted?: boolean | null;
  };
  symbols: {
    cgEventSetWindowLocationAvailable?: boolean | null;
  };
  processes: Array<{
    pid: number;
    appName: string;
    bundleId?: string | null;
    isActive?: boolean | null;
    activationPolicy?: string | null;
    executablePath?: string | null;
  }>;
  windows: BackgroundCgEventWindow[];
  recommendedWindow?: BackgroundCgEventWindow | null;
  ax: {
    suitable: boolean;
    trusted?: boolean | null;
    appWindowCount: number;
    errors: string[];
    reasons: string[];
    perPid: Array<{
      pid: number;
      ok: boolean;
      windowCount: number;
      error?: string | null;
    }>;
  };
  cgEvent: {
    suitable: boolean;
    canUseWindowLocation?: boolean | null;
    candidateWindowCount: number;
    reasons: string[];
  };
}

const HELPER_VERSION = 'v2';
const HELPER_SOURCE = String.raw`import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func emitJson(_ value: Any) {
  do {
    let data = try JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    fail("JSON encode failed: \(error)")
  }
}

func argValue(_ args: [String], _ name: String) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func intArg(_ args: [String], _ name: String) -> Int? {
  guard let value = argValue(args, name) else { return nil }
  return Int(value)
}

func doubleArg(_ args: [String], _ name: String) -> Double? {
  guard let value = argValue(args, name) else { return nil }
  return Double(value)
}

func number(_ value: Any?) -> Double? {
  if let double = value as? Double { return double }
  if let int = value as? Int { return Double(int) }
  if let number = value as? NSNumber { return number.doubleValue }
  return nil
}

func intNumber(_ value: Any?) -> Int? {
  if let int = value as? Int { return int }
  if let number = value as? NSNumber { return number.intValue }
  return nil
}

func stringValue(_ value: Any?) -> String? {
  if let string = value as? String, !string.isEmpty { return string }
  return nil
}

func boolValue(_ value: Any?) -> Bool? {
  if let bool = value as? Bool { return bool }
  if let number = value as? NSNumber { return number.boolValue }
  return nil
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
  switch policy {
  case .regular:
    return "regular"
  case .accessory:
    return "accessory"
  case .prohibited:
    return "prohibited"
  @unknown default:
    return "unknown"
  }
}

func jsonValue(_ value: Any?) -> Any {
  return value ?? NSNull()
}

func normalized(_ value: String) -> String {
  return value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func windowInfoList() -> [[String: Any]] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  return raw
}

func parseWindow(_ info: [String: Any]) -> [String: Any]? {
  guard
    let pid = intNumber(info[kCGWindowOwnerPID as String]),
    let windowId = intNumber(info[kCGWindowNumber as String]),
    let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
    let x = number(boundsDict["X"]),
    let y = number(boundsDict["Y"]),
    let width = number(boundsDict["Width"]),
    let height = number(boundsDict["Height"]),
    width > 0,
    height > 0
  else {
    return nil
  }

  let running = NSRunningApplication(processIdentifier: pid_t(pid))
  let appName = stringValue(info[kCGWindowOwnerName as String])
    ?? running?.localizedName
    ?? "pid \(pid)"
  let title = stringValue(info[kCGWindowName as String])
  return [
    "windowId": windowId,
    "pid": pid,
    "appName": appName,
    "bundleId": jsonValue(running?.bundleIdentifier),
    "title": jsonValue(title),
    "bounds": [
      "x": x,
      "y": y,
      "width": width,
      "height": height,
    ],
    "layer": jsonValue(intNumber(info[kCGWindowLayer as String])),
    "alpha": jsonValue(number(info[kCGWindowAlpha as String])),
    "isOnScreen": jsonValue(boolValue(info[kCGWindowIsOnscreen as String])),
  ]
}

func listWindows(_ args: [String]) {
  let targetApp = argValue(args, "--target-app").map(normalized)
  let limit = intArg(args, "--limit") ?? 80
  var output: [[String: Any]] = []
  for info in windowInfoList() {
    guard let window = parseWindow(info) else { continue }
    if let targetApp {
      let appName = normalized((window["appName"] as? String) ?? "")
      let bundleId = normalized((window["bundleId"] as? String) ?? "")
      if appName != targetApp && bundleId != targetApp {
        continue
      }
    }
    output.append(window)
    if output.count >= max(1, limit) { break }
  }
  emitJson(output)
}

func findWindow(pid: Int, windowId: Int) -> [String: Any]? {
  for info in windowInfoList() {
    guard let window = parseWindow(info) else { continue }
    guard
      let currentPid = window["pid"] as? Int,
      let currentWindowId = window["windowId"] as? Int,
      currentPid == pid,
      currentWindowId == windowId
    else {
      continue
    }
    return window
  }
  return nil
}

typealias CGEventSetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

func setPrivateWindowLocation(_ event: CGEvent, _ point: CGPoint) -> Bool {
  guard let handle = dlopen(nil, RTLD_NOW) else {
    return false
  }
  guard let symbol = dlsym(handle, "CGEventSetWindowLocation") else {
    return false
  }
  let fn = unsafeBitCast(symbol, to: CGEventSetWindowLocationFn.self)
  fn(event, point)
  return true
}

func hasPrivateWindowLocationSymbol() -> Bool {
  guard let handle = dlopen(nil, RTLD_NOW) else {
    return false
  }
  return dlsym(handle, "CGEventSetWindowLocation") != nil
}

func axErrorName(_ error: AXError) -> String {
  switch error {
  case .success:
    return "success"
  case .failure:
    return "failure"
  case .illegalArgument:
    return "illegalArgument"
  case .invalidUIElement:
    return "invalidUIElement"
  case .invalidUIElementObserver:
    return "invalidUIElementObserver"
  case .cannotComplete:
    return "cannotComplete"
  case .attributeUnsupported:
    return "attributeUnsupported"
  case .actionUnsupported:
    return "actionUnsupported"
  case .notificationUnsupported:
    return "notificationUnsupported"
  case .notImplemented:
    return "notImplemented"
  case .notificationAlreadyRegistered:
    return "notificationAlreadyRegistered"
  case .notificationNotRegistered:
    return "notificationNotRegistered"
  case .apiDisabled:
    return "apiDisabled"
  case .noValue:
    return "noValue"
  case .parameterizedAttributeUnsupported:
    return "parameterizedAttributeUnsupported"
  case .notEnoughPrecision:
    return "notEnoughPrecision"
  @unknown default:
    return "unknown"
  }
}

func axWindowProbe(pid: Int) -> [String: Any] {
  let appElement = AXUIElementCreateApplication(pid_t(pid))
  var windowsValue: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue)
  if error != .success {
    return [
      "pid": pid,
      "ok": false,
      "windowCount": 0,
      "error": axErrorName(error),
    ]
  }
  let windows = windowsValue as? [AXUIElement] ?? []
  return [
    "pid": pid,
    "ok": true,
    "windowCount": windows.count,
    "error": NSNull(),
  ]
}

func appMatches(_ app: NSRunningApplication, _ target: String) -> Bool {
  let normalizedTarget = normalized(target)
  let appName = normalized(app.localizedName ?? "")
  let bundleId = normalized(app.bundleIdentifier ?? "")
  return appName == normalizedTarget || bundleId == normalizedTarget
}

func runningApps(_ targetApp: String?) -> [[String: Any]] {
  let apps = NSWorkspace.shared.runningApplications
    .filter { app in
      guard let targetApp else { return true }
      return appMatches(app, targetApp)
    }
    .map { app in
      [
        "pid": Int(app.processIdentifier),
        "appName": app.localizedName ?? "pid \(app.processIdentifier)",
        "bundleId": jsonValue(app.bundleIdentifier),
        "isActive": app.isActive,
        "activationPolicy": activationPolicyName(app.activationPolicy),
        "executablePath": jsonValue(app.executableURL?.path),
      ] as [String: Any]
    }
  return apps
}

func eventTypes(button: String, isDown: Bool) -> NSEvent.EventType {
  if button == "right" {
    return isDown ? .rightMouseDown : .rightMouseUp
  }
  return isDown ? .leftMouseDown : .leftMouseUp
}

func buttonNumber(_ button: String) -> Int64 {
  return button == "right" ? 1 : 0
}

func setRawIntegerField(_ event: CGEvent, _ rawValue: CGEventField.RawValue, _ value: Int64) -> Bool {
  guard let field = CGEventField(rawValue: rawValue) else {
    return false
  }
  event.setIntegerValueField(field, value: value)
  return true
}

func makeEvent(
  pid: Int,
  windowId: Int,
  screenPoint: CGPoint,
  windowLocalPoint: CGPoint,
  button: String,
  clickCount: Int,
  eventNumber: Int,
  isDown: Bool,
  targetIsActive: Bool
) -> (CGEvent, Bool)? {
  var flags: NSEvent.ModifierFlags = []
  if !targetIsActive {
    flags.insert(.command)
  }

  guard let nsEvent = NSEvent.mouseEvent(
    with: eventTypes(button: button, isDown: isDown),
    location: screenPoint,
    modifierFlags: flags,
    timestamp: ProcessInfo.processInfo.systemUptime,
    windowNumber: windowId,
    context: nil,
    eventNumber: eventNumber,
    clickCount: clickCount,
    pressure: isDown ? 1.0 : 0.0
  ), let cgEvent = nsEvent.cgEvent else {
    return nil
  }

  cgEvent.location = screenPoint
  cgEvent.flags = CGEventFlags(rawValue: UInt64(flags.rawValue))
  cgEvent.setIntegerValueField(.mouseEventButtonNumber, value: buttonNumber(button))
  guard
    setRawIntegerField(cgEvent, 7, 3),
    setRawIntegerField(cgEvent, 91, Int64(windowId)),
    setRawIntegerField(cgEvent, 92, Int64(windowId))
  else {
    return nil
  }
  let usedWindowLocation = setPrivateWindowLocation(cgEvent, windowLocalPoint)
  return (cgEvent, usedWindowLocation)
}

func clickWindow(_ args: [String]) {
  guard let pid = intArg(args, "--pid"), pid > 0 else { fail("--pid is required") }
  guard let windowId = intArg(args, "--window-id"), windowId > 0 else { fail("--window-id is required") }
  guard let windowX = doubleArg(args, "--window-x"), windowX.isFinite else { fail("--window-x is required") }
  guard let windowY = doubleArg(args, "--window-y"), windowY.isFinite else { fail("--window-y is required") }
  let button = argValue(args, "--button") == "right" ? "right" : "left"
  let clickCount = min(2, max(1, intArg(args, "--click-count") ?? 1))

  guard let window = findWindow(pid: pid, windowId: windowId) else {
    fail("Target window not found for pid \(pid), windowId \(windowId)")
  }
  guard
    let bounds = window["bounds"] as? [String: Any],
    let boundsX = bounds["x"] as? Double,
    let boundsY = bounds["y"] as? Double,
    let boundsWidth = bounds["width"] as? Double,
    let boundsHeight = bounds["height"] as? Double
  else {
    fail("Target window bounds unavailable")
  }

  if windowX < 0 || windowY < 0 || windowX > boundsWidth || windowY > boundsHeight {
    fail("Window local point is outside target bounds")
  }

  let screenPoint = CGPoint(x: boundsX + windowX, y: boundsY + windowY)
  let windowLocalPoint = CGPoint(x: windowX, y: windowY)
  let running = NSRunningApplication(processIdentifier: pid_t(pid))
  let targetIsActive = running?.isActive ?? false
  var usedWindowLocation = false
  var eventNumbers: [Int] = []

  for index in 1...clickCount {
    let eventNumber = Int((ProcessInfo.processInfo.systemUptime * 1_000_000).truncatingRemainder(dividingBy: 2_147_483_647)) + index
    eventNumbers.append(eventNumber)
    guard let down = makeEvent(
      pid: pid,
      windowId: windowId,
      screenPoint: screenPoint,
      windowLocalPoint: windowLocalPoint,
      button: button,
      clickCount: clickCount,
      eventNumber: eventNumber,
      isDown: true,
      targetIsActive: targetIsActive
    ) else {
      fail("Failed to create mouseDown CGEvent")
    }
    usedWindowLocation = usedWindowLocation || down.1
    down.0.postToPid(pid_t(pid))

    guard let up = makeEvent(
      pid: pid,
      windowId: windowId,
      screenPoint: screenPoint,
      windowLocalPoint: windowLocalPoint,
      button: button,
      clickCount: clickCount,
      eventNumber: eventNumber,
      isDown: false,
      targetIsActive: targetIsActive
    ) else {
      fail("Failed to create mouseUp CGEvent")
    }
    usedWindowLocation = usedWindowLocation || up.1
    up.0.postToPid(pid_t(pid))
    usleep(60_000)
  }

  var result = window
  result["windowLocalPoint"] = ["x": windowX, "y": windowY]
  result["screenPoint"] = ["x": Double(screenPoint.x), "y": Double(screenPoint.y)]
  result["button"] = button
  result["clickCount"] = clickCount
  result["isTargetActive"] = targetIsActive
  result["usedWindowLocation"] = usedWindowLocation
  result["eventNumbers"] = eventNumbers
  emitJson(result)
}

func diagnoseApp(_ args: [String]) {
  let targetApp = argValue(args, "--target-app")
  let apps = runningApps(targetApp)
  let appPids = Set(apps.compactMap { $0["pid"] as? Int })
  let windows = windowInfoList()
    .compactMap { parseWindow($0) }
    .filter { window in
      guard let targetApp else { return true }
      let appName = normalized((window["appName"] as? String) ?? "")
      let bundleId = normalized((window["bundleId"] as? String) ?? "")
      let target = normalized(targetApp)
      if appName == target || bundleId == target { return true }
      if let pid = window["pid"] as? Int, appPids.contains(pid) { return true }
      return false
    }
  let axProbes = apps
    .compactMap { $0["pid"] as? Int }
    .prefix(8)
    .map { axWindowProbe(pid: $0) }

  emitJson([
    "targetApp": jsonValue(targetApp),
    "capturedAtMs": Int(Date().timeIntervalSince1970 * 1000),
    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    "accessibilityTrusted": AXIsProcessTrusted(),
    "screenRecordingGranted": CGPreflightScreenCaptureAccess(),
    "cgEventSetWindowLocationAvailable": hasPrivateWindowLocationSymbol(),
    "processes": apps,
    "windows": windows,
    "ax": axProbes,
  ])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  fail("command required: list-windows | click | diagnose-app")
}

switch command {
case "list-windows":
  listWindows(args)
case "click":
  clickWindow(args)
case "diagnose-app":
  diagnoseApp(args)
default:
  fail("unknown command: \(command)")
}
`;

const helperHash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 12);
let helperPromise: Promise<string> | null = null;

class BackgroundCgEventSurface {
  async listWindows(options: ListBackgroundCgEventWindowsOptions = {}): Promise<BackgroundCgEventWindow[]> {
    if (process.platform !== 'darwin') {
      throw new Error(`Background CGEvent surface is only available on macOS, not ${process.platform}.`);
    }
    const limit = clampInt(options.limit, 1, 200, 80);
    const rawLimit = Math.min(200, Math.max(limit * 4, 80));
    const args = ['list-windows', '--limit', String(rawLimit)];
    const stdout = await this.runHelper(args, options.timeoutMs);
    const parsed = parseJson(stdout);
    if (!Array.isArray(parsed)) {
      throw new Error('Background CGEvent helper returned a non-array window list.');
    }
    return rankWindowCandidates(
      parsed.map(parseWindow).filter((item): item is BackgroundCgEventWindow => Boolean(item)),
      options,
    ).slice(0, limit);
  }

  async clickWindow(request: BackgroundCgEventClickRequest): Promise<BackgroundCgEventClickResult> {
    if (process.platform !== 'darwin') {
      throw new Error(`Background CGEvent surface is only available on macOS, not ${process.platform}.`);
    }
    const resolvedRef = resolveWindowRef(request.windowRef);
    const pid = request.pid ?? resolvedRef?.pid;
    const windowId = request.windowId ?? resolvedRef?.windowId;
    if (!Number.isFinite(pid) || !pid || pid <= 0) {
      throw new Error('pid must be a positive number.');
    }
    if (!Number.isFinite(windowId) || !windowId || windowId <= 0) {
      throw new Error('windowId must be a positive number.');
    }
    if (!isFinitePoint(request.windowLocalPoint)) {
      throw new Error('windowLocalPoint must include finite x and y numbers.');
    }

    const targetVerification = await this.verifyWindowTarget({
      ...request,
      pid,
      windowId,
    });
    if (!targetVerification.ok) {
      throw new Error(`Target window verification failed: ${targetVerification.mismatches.join('; ')}`);
    }

    const clickCount = Math.max(1, Math.min(2, Math.trunc(request.clickCount || 1)));
    const args = [
      'click',
      '--pid',
      String(Math.trunc(pid)),
      '--window-id',
      String(Math.trunc(windowId)),
      '--window-x',
      String(request.windowLocalPoint.x),
      '--window-y',
      String(request.windowLocalPoint.y),
      '--button',
      request.button === 'right' ? 'right' : 'left',
      '--click-count',
      String(clickCount),
    ];
    const stdout = await this.runHelper(args, request.timeoutMs);
    const parsed = parseJson(stdout);
    const window = enrichWindow(parseWindow(parsed), request);
    if (!window) {
      throw new Error('Background CGEvent helper returned invalid click metadata.');
    }
    const record = parsed as Record<string, unknown>;
    const screenPoint = parsePoint(record.screenPoint);
    const windowLocalPoint = parsePoint(record.windowLocalPoint);
    const eventNumbers = Array.isArray(record.eventNumbers)
      ? record.eventNumbers.filter((item): item is number => typeof item === 'number')
      : undefined;
    return {
      ...window,
      windowLocalPoint: windowLocalPoint || request.windowLocalPoint,
      screenPoint: screenPoint || {
        x: window.bounds.x + request.windowLocalPoint.x,
        y: window.bounds.y + request.windowLocalPoint.y,
      },
      button: record.button === 'right' ? 'right' : 'left',
      clickCount: typeof record.clickCount === 'number' ? record.clickCount : clickCount,
      isTargetActive: record.isTargetActive === true,
      usedWindowLocation: record.usedWindowLocation === true,
      eventNumbers,
      targetVerification,
    };
  }

  async diagnoseApp(options: ListBackgroundCgEventWindowsOptions = {}): Promise<BackgroundCgEventAppDiagnosis> {
    if (process.platform !== 'darwin') {
      throw new Error(`Background CGEvent app diagnosis is only available on macOS, not ${process.platform}.`);
    }
    const helperPath = await ensureHelper();
    const args = ['diagnose-app'];
    if (options.targetApp) {
      args.push('--target-app', options.targetApp);
    }
    const stdout = await this.runHelper(args, options.timeoutMs);
    const parsed = parseJson(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Background CGEvent helper returned invalid app diagnosis.');
    }
    return parseDiagnosis(parsed as Record<string, unknown>, {
      ...options,
      helperPath,
    });
  }

  private async verifyWindowTarget(
    request: Required<Pick<BackgroundCgEventClickRequest, 'pid' | 'windowId'>> & BackgroundCgEventClickRequest,
  ): Promise<BackgroundCgEventTargetVerification> {
    const windows = await this.listWindows({
      targetApp: request.targetApp,
      bundleId: request.bundleId,
      title: request.title,
      pid: request.pid,
      windowId: request.windowId,
      limit: 20,
      timeoutMs: request.timeoutMs,
    });
    const currentWindow = windows.find((window) => window.pid === request.pid && window.windowId === request.windowId) || null;
    const expected = {
      pid: request.pid,
      windowId: request.windowId,
      windowRef: request.windowRef || null,
      targetApp: request.targetApp || null,
      bundleId: request.bundleId || null,
      title: request.title || null,
    };
    const mismatches: string[] = [];
    const warnings: string[] = [];
    if (!currentWindow) {
      mismatches.push(`window pid=${request.pid} windowId=${request.windowId} is not visible now`);
    } else {
      if (request.targetApp && !matchesTargetApp(currentWindow, request.targetApp)) {
        mismatches.push(`targetApp changed: expected ${request.targetApp}, got ${currentWindow.appName}/${currentWindow.bundleId || 'no bundleId'}`);
      }
      if (request.bundleId && currentWindow.bundleId !== request.bundleId) {
        mismatches.push(`bundleId changed: expected ${request.bundleId}, got ${currentWindow.bundleId || 'null'}`);
      }
      if (request.title && currentWindow.title !== request.title) {
        mismatches.push(`title changed: expected "${request.title}", got "${currentWindow.title || ''}"`);
      }
      if (request.windowRef && currentWindow.windowRef !== request.windowRef) {
        mismatches.push(`windowRef is stale: expected ${request.windowRef}, got ${currentWindow.windowRef || 'null'}`);
      }
      if (currentWindow.qualityGrade === 'low') {
        warnings.push(`target window quality is low: ${(currentWindow.qualityReasons || []).join('; ')}`);
      }
    }
    return {
      ok: mismatches.length === 0,
      stale: mismatches.length > 0,
      checkedAtMs: Date.now(),
      expected,
      currentWindow,
      mismatches,
      warnings,
    };
  }

  private async runHelper(args: string[], timeoutMs = 10_000): Promise<string> {
    const helper = await ensureHelper();
    const { stdout } = await execFileAsync(helper, args, {
      timeout: Math.max(1_000, Math.min(timeoutMs, 60_000)),
      maxBuffer: 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  }
}

async function ensureHelper(): Promise<string> {
  if (!helperPromise) {
    helperPromise = buildHelper();
  }
  return helperPromise;
}

async function buildHelper(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'code-agent-background-cgevent');
  const sourcePath = path.join(dir, `background-cgevent-${HELPER_VERSION}-${helperHash}.swift`);
  const binaryPath = path.join(dir, `background-cgevent-${HELPER_VERSION}-${helperHash}`);
  await mkdir(dir, { recursive: true });

  const currentSource = existsSync(sourcePath)
    ? await readFile(sourcePath, 'utf8').catch(() => '')
    : '';
  if (currentSource !== HELPER_SOURCE) {
    await writeFile(sourcePath, HELPER_SOURCE, 'utf8');
  }

  if (!existsSync(binaryPath)) {
    await execFileAsync('xcrun', [
      'swiftc',
      sourcePath,
      '-o',
      binaryPath,
      '-framework',
      'AppKit',
      '-framework',
      'CoreGraphics',
    ], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }

  return binaryPath;
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    throw new Error('Background CGEvent helper returned empty output.');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Background CGEvent helper returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`);
  }
}

function parseWindow(value: unknown): BackgroundCgEventWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const bounds = parseBounds(record.bounds);
  if (
    typeof record.windowId !== 'number'
    || typeof record.pid !== 'number'
    || typeof record.appName !== 'string'
    || !bounds
  ) {
    return null;
  }
  return {
    windowId: record.windowId,
    pid: record.pid,
    appName: record.appName,
    bundleId: typeof record.bundleId === 'string' ? record.bundleId : null,
    title: typeof record.title === 'string' ? record.title : null,
    bounds,
    layer: typeof record.layer === 'number' ? record.layer : null,
    alpha: typeof record.alpha === 'number' ? record.alpha : null,
    isOnScreen: typeof record.isOnScreen === 'boolean' ? record.isOnScreen : null,
  };
}

function enrichWindow(
  window: BackgroundCgEventWindow | null,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest = {},
): BackgroundCgEventWindow | null {
  if (!window) return null;
  const quality = scoreWindowCandidate(window, options);
  return {
    ...window,
    windowRef: createWindowRef(window),
    qualityScore: quality.score,
    qualityGrade: quality.grade,
    qualityReasons: quality.reasons,
  };
}

function rankWindowCandidates(
  windows: BackgroundCgEventWindow[],
  options: ListBackgroundCgEventWindowsOptions = {},
): BackgroundCgEventWindow[] {
  const hasSpecificFilter = Boolean(options.targetApp || options.bundleId || options.title || options.pid || options.windowId);
  const enriched = windows
    .filter((window) => matchesWindowFilters(window, options))
    .map((window) => enrichWindow(window, options))
    .filter((window): window is BackgroundCgEventWindow => Boolean(window))
    .filter((window) => hasSpecificFilter || (window.qualityScore || 0) >= 45);
  enriched.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0) || a.windowId - b.windowId);
  if (enriched[0]) {
    enriched[0].recommended = true;
  }
  return enriched;
}

function matchesWindowFilters(
  window: BackgroundCgEventWindow,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest,
): boolean {
  if (options.targetApp && !matchesTargetApp(window, options.targetApp)) {
    return false;
  }
  if (options.bundleId && window.bundleId !== options.bundleId) {
    return false;
  }
  if (options.title && window.title !== options.title) {
    return false;
  }
  if (typeof options.pid === 'number' && window.pid !== Math.trunc(options.pid)) {
    return false;
  }
  if (typeof options.windowId === 'number' && window.windowId !== Math.trunc(options.windowId)) {
    return false;
  }
  return true;
}

function matchesTargetApp(window: BackgroundCgEventWindow, targetApp: string): boolean {
  const target = normalizeForMatch(targetApp);
  return normalizeForMatch(window.appName) === target
    || normalizeForMatch(window.bundleId || '') === target;
}

function scoreWindowCandidate(
  window: BackgroundCgEventWindow,
  options: ListBackgroundCgEventWindowsOptions | BackgroundCgEventClickRequest,
): { score: number; grade: 'recommended' | 'usable' | 'low'; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (window.layer === 0) {
    score += 24;
    reasons.push('ordinary layer');
  } else {
    score -= 18;
    reasons.push(`non-ordinary layer ${window.layer ?? 'unknown'}`);
  }

  if (window.isOnScreen !== false) {
    score += 10;
  } else {
    score -= 20;
    reasons.push('not on screen');
  }

  if (window.alpha === null || window.alpha === undefined || window.alpha > 0.2) {
    score += 8;
  } else {
    score -= 12;
    reasons.push(`low alpha ${window.alpha}`);
  }

  if (hasReasonableBounds(window.bounds)) {
    score += 20;
    reasons.push('reasonable bounds');
  } else {
    score -= 24;
    reasons.push(`unreasonable bounds ${formatBounds(window.bounds)}`);
  }

  if (isLikelySystemWindowOwner(window)) {
    score -= 35;
    reasons.push('system owner');
  } else {
    score += 18;
    reasons.push('non-system owner');
  }

  if (window.title) {
    score += 8;
    reasons.push('has title');
  } else {
    score -= 4;
    reasons.push('no title');
  }

  if (options.targetApp) {
    if (matchesTargetApp(window, options.targetApp)) {
      score += 18;
      reasons.push('matches targetApp');
    } else {
      score -= 45;
      reasons.push('does not match targetApp');
    }
  }
  if (options.bundleId) {
    if (window.bundleId === options.bundleId) {
      score += 18;
      reasons.push('matches bundleId');
    } else {
      score -= 45;
      reasons.push('does not match bundleId');
    }
  }
  if (options.title) {
    if (window.title === options.title) {
      score += 12;
      reasons.push('matches title');
    } else {
      score -= 25;
      reasons.push('does not match title');
    }
  }
  if (typeof options.pid === 'number') {
    if (window.pid === Math.trunc(options.pid)) {
      score += 12;
      reasons.push('matches pid');
    } else {
      score -= 30;
      reasons.push('does not match pid');
    }
  }
  if (typeof options.windowId === 'number') {
    if (window.windowId === Math.trunc(options.windowId)) {
      score += 12;
      reasons.push('matches windowId');
    } else {
      score -= 30;
      reasons.push('does not match windowId');
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const grade = clamped >= 75 ? 'recommended' : clamped >= 50 ? 'usable' : 'low';
  return {
    score: clamped,
    grade,
    reasons,
  };
}

function parseDiagnosis(
  record: Record<string, unknown>,
  options: ListBackgroundCgEventWindowsOptions & { helperPath: string },
): BackgroundCgEventAppDiagnosis {
  const rawWindows = Array.isArray(record.windows) ? record.windows : [];
  const windows = rankWindowCandidates(
    rawWindows.map(parseWindow).filter((item): item is BackgroundCgEventWindow => Boolean(item)),
    options,
  );
  const processes = Array.isArray(record.processes)
    ? record.processes.map(parseProcess).filter((item): item is BackgroundCgEventAppDiagnosis['processes'][number] => Boolean(item))
    : [];
  const axPerPid = Array.isArray(record.ax)
    ? record.ax.map(parseAxProbe).filter((item): item is BackgroundCgEventAppDiagnosis['ax']['perPid'][number] => Boolean(item))
    : [];
  const accessibilityTrusted = typeof record.accessibilityTrusted === 'boolean' ? record.accessibilityTrusted : null;
  const screenRecordingGranted = typeof record.screenRecordingGranted === 'boolean' ? record.screenRecordingGranted : null;
  const windowLocationAvailable = typeof record.cgEventSetWindowLocationAvailable === 'boolean'
    ? record.cgEventSetWindowLocationAvailable
    : null;
  const axErrors = axPerPid
    .map((probe) => probe.error)
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
  const axWindowCount = axPerPid.reduce((sum, probe) => sum + probe.windowCount, 0);
  const axReasons: string[] = [];
  if (!accessibilityTrusted) axReasons.push('Accessibility permission is not trusted');
  if (processes.length === 0) axReasons.push('target app is not running');
  if (axWindowCount === 0) axReasons.push('no AX windows returned');
  if (axErrors.length > 0) axReasons.push(`AX probe errors: ${[...new Set(axErrors)].join(', ')}`);
  if (axReasons.length === 0) axReasons.push('AX can read target windows');

  const cgEventReasons: string[] = [];
  if (!screenRecordingGranted) cgEventReasons.push('Screen Recording is not granted; window titles/bounds may be incomplete');
  if (!windowLocationAvailable) cgEventReasons.push('CGEventSetWindowLocation symbol is unavailable; helper can only rely on screen location');
  if (windows.length === 0) cgEventReasons.push('no candidate CGWindow found');
  if (windows[0]?.qualityGrade === 'low') cgEventReasons.push('best candidate window has low quality score');
  if (cgEventReasons.length === 0) cgEventReasons.push('CGEvent has a recommended candidate window');

  return {
    targetApp: typeof record.targetApp === 'string' ? record.targetApp : options.targetApp || null,
    capturedAtMs: typeof record.capturedAtMs === 'number' ? record.capturedAtMs : Date.now(),
    platform: process.platform,
    helper: {
      available: true,
      path: options.helperPath,
    },
    os: {
      version: typeof record.osVersion === 'string' ? record.osVersion : null,
    },
    permissions: {
      accessibilityTrusted,
      screenRecordingGranted,
    },
    symbols: {
      cgEventSetWindowLocationAvailable: windowLocationAvailable,
    },
    processes,
    windows,
    recommendedWindow: windows[0] || null,
    ax: {
      suitable: Boolean(accessibilityTrusted && processes.length > 0 && axWindowCount > 0 && axErrors.length === 0),
      trusted: accessibilityTrusted,
      appWindowCount: axWindowCount,
      errors: [...new Set(axErrors)],
      reasons: axReasons,
      perPid: axPerPid,
    },
    cgEvent: {
      suitable: Boolean(windows.length > 0 && windows[0]?.qualityGrade !== 'low'),
      canUseWindowLocation: windowLocationAvailable,
      candidateWindowCount: windows.length,
      reasons: cgEventReasons,
    },
  };
}

function parseProcess(value: unknown): BackgroundCgEventAppDiagnosis['processes'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || typeof record.appName !== 'string') return null;
  return {
    pid: record.pid,
    appName: record.appName,
    bundleId: typeof record.bundleId === 'string' ? record.bundleId : null,
    isActive: typeof record.isActive === 'boolean' ? record.isActive : null,
    activationPolicy: typeof record.activationPolicy === 'string' ? record.activationPolicy : null,
    executablePath: typeof record.executablePath === 'string' ? record.executablePath : null,
  };
}

function parseAxProbe(value: unknown): BackgroundCgEventAppDiagnosis['ax']['perPid'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number') return null;
  return {
    pid: record.pid,
    ok: record.ok === true,
    windowCount: typeof record.windowCount === 'number' ? record.windowCount : 0,
    error: typeof record.error === 'string' ? record.error : null,
  };
}

function createWindowRef(window: BackgroundCgEventWindow): string {
  const hash = createHash('sha256')
    .update([
      window.bundleId || window.appName,
      window.title || '',
      Math.round(window.bounds.x),
      Math.round(window.bounds.y),
      Math.round(window.bounds.width),
      Math.round(window.bounds.height),
    ].join('|'))
    .digest('hex')
    .slice(0, 12);
  return `cgwin:${window.pid}:${window.windowId}:${hash}`;
}

function resolveWindowRef(windowRef: string | undefined): { pid: number; windowId: number; hash: string } | null {
  if (!windowRef) return null;
  const match = /^cgwin:(\d+):(\d+):([a-f0-9]{12})$/i.exec(windowRef.trim());
  if (!match) return null;
  return {
    pid: Number.parseInt(match[1], 10),
    windowId: Number.parseInt(match[2], 10),
    hash: match[3],
  };
}

function parseBounds(value: unknown): BackgroundCgEventWindowBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.x !== 'number'
    || typeof record.y !== 'number'
    || typeof record.width !== 'number'
    || typeof record.height !== 'number'
  ) {
    return null;
  }
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  };
}

function hasReasonableBounds(bounds: BackgroundCgEventWindowBounds): boolean {
  return bounds.width >= 80
    && bounds.height >= 40
    && bounds.width <= 10000
    && bounds.height <= 10000;
}

function formatBounds(bounds: BackgroundCgEventWindowBounds): string {
  return `${roundPoint(bounds.x)},${roundPoint(bounds.y)} ${roundPoint(bounds.width)}x${roundPoint(bounds.height)}`;
}

function roundPoint(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isLikelySystemWindowOwner(window: BackgroundCgEventWindow): boolean {
  const app = normalizeForMatch(window.appName);
  const bundle = normalizeForMatch(window.bundleId || '');
  return [
    'window server',
    'loginwindow',
    'dock',
    'systemuiserver',
    'control center',
    'notificationcenter',
    'wallpaper',
  ].includes(app)
    || bundle.startsWith('com.apple.dock')
    || bundle.startsWith('com.apple.windowserver')
    || bundle === 'com.apple.loginwindow'
    || bundle === 'com.apple.systemuiserver'
    || bundle === 'com.apple.controlcenter'
    || bundle === 'com.apple.notificationcenterui';
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

function parsePoint(value: unknown): BackgroundCgEventWindowPoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.x !== 'number' || typeof record.y !== 'number') {
    return null;
  }
  return { x: record.x, y: record.y };
}

function isFinitePoint(value: BackgroundCgEventWindowPoint | undefined): value is BackgroundCgEventWindowPoint {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export const backgroundCgEventSurface = new BackgroundCgEventSurface();
