import AVFoundation
import Foundation

let sem = DispatchSemaphore(value: 0)
var result = "unknown"
AVCaptureDevice.requestAccess(for: .audio) { granted in
    result = granted ? "granted" : "denied"
    sem.signal()
}
_ = sem.wait(timeout: .now() + 15)
print(result)
