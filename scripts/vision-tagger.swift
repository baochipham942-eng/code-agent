// vision-tagger.swift
// macOS Vision Framework 工具：人脸检测 + 图像主题分类 + 物体定位框
// 编译: swiftc -O -framework Vision -framework AppKit -o vision-tagger vision-tagger.swift
// 用法: ./vision-tagger --photo <path> --mode <face|classify|all> [--output <json-path>]
// 需要: macOS 11+

import Foundation
import Vision
import AppKit

// MARK: - 通用工具

func loadCGImage(_ imagePath: String) -> (CGImage, Int, Int)? {
    let absolutePath = (imagePath as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: absolutePath) else {
        return nil
    }
    guard let image = NSImage(contentsOfFile: absolutePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return nil
    }
    return (cgImage, cgImage.width, cgImage.height)
}

// Vision 的 boundingBox 是归一化（0-1），原点左下。转换为左上原点像素坐标。
func denormalizeBox(
    _ bbox: CGRect,
    imageWidth: Int,
    imageHeight: Int,
) -> [String: Int] {
    let x = bbox.minX * CGFloat(imageWidth)
    let yTop = (1.0 - bbox.maxY) * CGFloat(imageHeight)
    let w = bbox.width * CGFloat(imageWidth)
    let h = bbox.height * CGFloat(imageHeight)
    return [
        "x": Int(x.rounded()),
        "y": Int(yTop.rounded()),
        "width": Int(w.rounded()),
        "height": Int(h.rounded()),
    ]
}

// MARK: - 人脸检测

func detectFaces(cgImage: CGImage, imageWidth: Int, imageHeight: Int) -> [[String: Any]] {
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }
    guard let observations = request.results else { return [] }
    var faces: [[String: Any]] = []
    for (idx, obs) in observations.enumerated() {
        faces.append([
            "index": idx,
            "confidence": obs.confidence,
            "boundingBox": denormalizeBox(obs.boundingBox, imageWidth: imageWidth, imageHeight: imageHeight),
        ])
    }
    return faces
}

// MARK: - 人脸特征向量（聚类用）

func generateFaceFeaturePrints(cgImage: CGImage, faces: [[String: Any]]) -> [[String: Any]] {
    // 用 VNGenerateImageFeaturePrintRequest 给每张脸的裁剪图生成 feature print
    // 用于后续人脸聚类（cosine similarity 或欧氏距离阈值聚类）
    let width = cgImage.width
    let height = cgImage.height
    var enriched: [[String: Any]] = []

    for face in faces {
        guard let bbox = face["boundingBox"] as? [String: Int],
              let x = bbox["x"], let y = bbox["y"],
              let w = bbox["width"], let h = bbox["height"],
              w > 0, h > 0 else {
            enriched.append(face)
            continue
        }
        // 适度扩边，确保覆盖脸部全貌
        let padX = max(Int(Double(w) * 0.2), 10)
        let padY = max(Int(Double(h) * 0.2), 10)
        let cropX = max(0, x - padX)
        let cropY = max(0, y - padY)
        let cropW = min(width - cropX, w + padX * 2)
        let cropH = min(height - cropY, h + padY * 2)
        let cropRect = CGRect(x: cropX, y: cropY, width: cropW, height: cropH)
        guard let cropped = cgImage.cropping(to: cropRect) else {
            enriched.append(face)
            continue
        }
        let request = VNGenerateImageFeaturePrintRequest()
        let handler = VNImageRequestHandler(cgImage: cropped, options: [:])
        do {
            try handler.perform([request])
        } catch {
            enriched.append(face)
            continue
        }
        guard let result = request.results?.first,
              let data = result.data as Data? else {
            enriched.append(face)
            continue
        }
        // Feature print 是 Float32 数组，base64 编码方便 JSON 传输
        var enrichedFace = face
        enrichedFace["featurePrint"] = data.base64EncodedString()
        enrichedFace["featurePrintElementCount"] = result.elementCount
        enrichedFace["featurePrintElementType"] = String(describing: result.elementType)
        enriched.append(enrichedFace)
    }
    return enriched
}

// MARK: - 图像主题分类

func classifyImage(cgImage: CGImage) -> [[String: Any]] {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }
    guard let observations = request.results else { return [] }
    // top 10 高置信度类别（过滤极低置信度的）
    let topN = observations
        .filter { $0.confidence > 0.05 }
        .sorted { $0.confidence > $1.confidence }
        .prefix(10)
    return topN.map { obs in
        [
            "identifier": obs.identifier,
            "confidence": obs.confidence,
        ]
    }
}

// MARK: - 主流程

func runVisionTagger(imagePath: String, mode: String) -> [String: Any] {
    guard let (cgImage, width, height) = loadCGImage(imagePath) else {
        return ["ok": false, "error": "image_load_failed", "path": imagePath]
    }
    let absolutePath = (imagePath as NSString).expandingTildeInPath

    var result: [String: Any] = [
        "ok": true,
        "path": absolutePath,
        "imageSize": ["width": width, "height": height],
        "mode": mode,
    ]

    switch mode {
    case "face":
        let faces = detectFaces(cgImage: cgImage, imageWidth: width, imageHeight: height)
        let withFeaturePrints = generateFaceFeaturePrints(cgImage: cgImage, faces: faces)
        result["faces"] = withFeaturePrints
        result["faceCount"] = withFeaturePrints.count
    case "classify":
        result["classifications"] = classifyImage(cgImage: cgImage)
    case "all":
        let faces = detectFaces(cgImage: cgImage, imageWidth: width, imageHeight: height)
        let withFeaturePrints = generateFaceFeaturePrints(cgImage: cgImage, faces: faces)
        result["faces"] = withFeaturePrints
        result["faceCount"] = withFeaturePrints.count
        result["classifications"] = classifyImage(cgImage: cgImage)
    default:
        return [
            "ok": false,
            "error": "invalid_mode",
            "details": "mode 必须是 face / classify / all",
            "path": absolutePath,
        ]
    }
    return result
}

// MARK: - CLI

let args = Array(CommandLine.arguments.dropFirst())
var photoPath: String?
var outputPath: String?
var mode = "all"
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
    case "--mode":
        guard i + 1 < args.count else {
            fputs("--mode 需要参数\n", stderr)
            exit(2)
        }
        mode = args[i + 1]
        i += 2
    case "--help", "-h":
        print("Usage: vision-tagger --photo <path> --mode <face|classify|all> [--output <json-path>]")
        print("")
        print("  --mode face     仅人脸检测 + 特征向量（用于聚类）")
        print("  --mode classify 仅图像主题分类（输出 top 10 类别）")
        print("  --mode all      人脸 + 主题（默认）")
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

let result = runVisionTagger(imagePath: path, mode: mode)
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
