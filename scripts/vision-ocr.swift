// vision-ocr.swift
// 用 macOS Vision Framework (VNRecognizeTextRequest) 做 OCR，输出 JSON 到 stdout 或文件。
// 编译: swiftc -O -framework Vision -framework AppKit -o vision-ocr vision-ocr.swift
// 用法: ./vision-ocr --photo <path> [--output <json-path>] [--languages zh-Hans,zh-Hant,en-US]
// 需要: macOS 11+（VNRecognizeTextRequest 中文支持需 macOS 13+）

import Foundation
import Vision
import AppKit

func runOCR(imagePath: String, languages: [String]) -> [String: Any] {
    let absolutePath = (imagePath as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: absolutePath) else {
        return ["ok": false, "error": "file_not_found", "path": absolutePath]
    }

    guard let image = NSImage(contentsOfFile: absolutePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ["ok": false, "error": "image_load_failed", "path": absolutePath]
    }
    let width = cgImage.width
    let height = cgImage.height

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return [
            "ok": false,
            "error": "ocr_failed",
            "details": "\(error)",
            "path": absolutePath,
        ]
    }

    guard let observations = request.results else {
        return [
            "ok": true,
            "path": absolutePath,
            "imageSize": ["width": width, "height": height],
            "fullText": "",
            "regions": [],
        ]
    }

    var regions: [[String: Any]] = []
    var lines: [String] = []

    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let text = candidate.string
        let confidence = candidate.confidence
        let bbox = obs.boundingBox
        // Vision 的 boundingBox 是归一化坐标 (0-1)，原点在左下角。
        // 转换为左上角原点的像素坐标，方便上层使用。
        let x = bbox.minX * CGFloat(width)
        let yTop = (1.0 - bbox.maxY) * CGFloat(height)
        let w = bbox.width * CGFloat(width)
        let h = bbox.height * CGFloat(height)

        regions.append([
            "text": text,
            "confidence": confidence,
            "boundingBox": [
                "x": Int(x.rounded()),
                "y": Int(yTop.rounded()),
                "width": Int(w.rounded()),
                "height": Int(h.rounded()),
            ],
        ])
        lines.append(text)
    }

    return [
        "ok": true,
        "path": absolutePath,
        "imageSize": ["width": width, "height": height],
        "fullText": lines.joined(separator: "\n"),
        "regions": regions,
        "languages": languages,
    ]
}

let args = Array(CommandLine.arguments.dropFirst())
var photoPath: String?
var outputPath: String?
var languages = ["zh-Hans", "zh-Hant", "en-US"]
var i = 0
while i < args.count {
    let arg = args[i]
    switch arg {
    case "--photo":
        guard i + 1 < args.count else {
            fputs("--photo 需要参数\n", stderr)
            exit(2)
        }
        photoPath = args[i + 1]
        i += 2
    case "--output":
        guard i + 1 < args.count else {
            fputs("--output 需要参数\n", stderr)
            exit(2)
        }
        outputPath = args[i + 1]
        i += 2
    case "--languages":
        guard i + 1 < args.count else {
            fputs("--languages 需要参数\n", stderr)
            exit(2)
        }
        languages = args[i + 1].split(separator: ",").map(String.init)
        i += 2
    case "--help", "-h":
        print("Usage: vision-ocr --photo <path> [--output <json-path>] [--languages zh-Hans,zh-Hant,en-US]")
        exit(0)
    default:
        fputs("未知参数: \(arg)\n", stderr)
        exit(2)
    }
}

guard let path = photoPath else {
    fputs("Error: --photo is required. Run with --help for usage.\n", stderr)
    exit(2)
}

let result = runOCR(imagePath: path, languages: languages)
let jsonData: Data
do {
    jsonData = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
} catch {
    fputs("JSON serialization failed: \(error)\n", stderr)
    exit(3)
}

if let outPath = outputPath {
    let outAbsPath = (outPath as NSString).expandingTildeInPath
    do {
        try jsonData.write(to: URL(fileURLWithPath: outAbsPath))
    } catch {
        fputs("Failed to write output: \(error)\n", stderr)
        exit(3)
    }
} else {
    FileHandle.standardOutput.write(jsonData)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

if let ok = result["ok"] as? Bool, !ok {
    exit(1)
}
exit(0)
