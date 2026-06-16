// PRD-66 Domain 4 — QuickLookThumbnailing. macOS 10.15+. Implements all 8
// CLI verbs (info / generate / batch + flags). References:
// apple-developer-docs/QuickLookThumbnailing/QLThumbnailGenerator.md.

import Foundation
import AppKit
import QuickLookThumbnailing
import UniformTypeIdentifiers
import ImageIO

final class ThumbnailDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "generate":  generate(action, completion: completion)
        case "batch":     batch(action, completion: completion)
        default:          completion(WireFormat.error("thumbnail.\(sub) — unknown verb"))
        }
    }

    private func parseSize(_ s: String?) -> CGSize {
        guard let s = s else { return CGSize(width: 256, height: 256) }
        if s.contains("x") {
            let parts = s.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { return CGSize(width: parts[0], height: parts[1]) }
        }
        if let n = Double(s) { return CGSize(width: n, height: n) }
        return CGSize(width: 256, height: 256)
    }

    private func parseTypes(_ s: String?) -> QLThumbnailGenerator.Request.RepresentationTypes {
        guard let s = s else { return .all }
        var mask: QLThumbnailGenerator.Request.RepresentationTypes = []
        for raw in s.split(separator: ",") {
            switch raw.trimmingCharacters(in: .whitespaces) {
            case "icon": mask.insert(.icon)
            case "thumbnail": mask.insert(.thumbnail)
            case "lowQuality", "lowQualityThumbnail": mask.insert(.lowQualityThumbnail)
            case "all": mask = .all
            default: break
            }
        }
        return mask.isEmpty ? .all : mask
    }

    private func format(_ s: String?) -> (String, CFString, String) {
        switch (s ?? "png").lowercased() {
        case "jpeg", "jpg": return ("jpeg", "public.jpeg" as CFString, "jpeg")
        case "heic": return ("heic", "public.heic" as CFString, "heic")
        default: return ("png", "public.png" as CFString, "png")
        }
    }

    private func generate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("thumbnail: missing path")); return }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        let size = parseSize(action["size"] as? String)
        let scale = (action["scale"] as? Int).map { CGFloat($0) } ?? 2
        let types = parseTypes(action["types"] as? String)
        let request = QLThumbnailGenerator.Request(fileAt: url, size: size, scale: scale, representationTypes: types)
        let outRequested = action["out"] as? String
        // --out implies save. Previously --out without --save fell through to
        // the dataUrl branch and silently never wrote the file.
        let save = ((action["save"] as? Bool) ?? false) || (outRequested != nil)
        let (formatName, _, ext) = format(action["format"] as? String)

        if save {
            let outURL: URL = {
                if let o = outRequested { return URL(fileURLWithPath: (o as NSString).expandingTildeInPath) }
                return url.appendingPathExtension("thumb.\(ext)")
            }()
            // Generate the representation and write the file ourselves instead
            // of QLThumbnailGenerator.saveBestRepresentation — that API routes
            // through a QuickLook service that the bridge can't write from
            // (EPERM "Operation not permitted"), even to /tmp. Encoding + a plain
            // Data.write uses the bridge's own file access, exactly like the
            // screenshot path which writes reliably.
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { thumbnail, error in
                if let error = error {
                    completion(WireFormat.error("thumbnail: \(error.localizedDescription)"))
                    return
                }
                guard let thumbnail = thumbnail else {
                    completion(WireFormat.error("thumbnail: no representation"))
                    return
                }
                guard let data = self.encode(thumbnail.nsImage, format: formatName) else {
                    completion(WireFormat.error("thumbnail: encode failed"))
                    return
                }
                do {
                    try data.write(to: outURL)
                } catch {
                    completion(WireFormat.error("thumbnail.save failed writing to \(outURL.path): \(error.localizedDescription) — pass an absolute --out under a writable directory (e.g. /tmp or ~/Downloads)"))
                    return
                }
                completion(WireFormat.success([
                    "path": path, "type": "thumbnail", "filePath": outURL.path,
                    "format": formatName, "bytes": data.count,
                    "width": Int(thumbnail.cgImage.width), "height": Int(thumbnail.cgImage.height), "scale": Int(scale),
                ]))
            }
        } else {
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { thumbnail, error in
                if let error = error {
                    completion(WireFormat.error("thumbnail: \(error.localizedDescription)"))
                    return
                }
                guard let thumbnail = thumbnail else {
                    completion(WireFormat.error("thumbnail: no representation"))
                    return
                }
                let nsImage = thumbnail.nsImage
                guard let data = self.encode(nsImage, format: formatName) else {
                    completion(WireFormat.error("thumbnail: encode failed"))
                    return
                }
                let dataUrl = "data:image/\(formatName);base64,\(data.base64EncodedString())"
                completion(WireFormat.success([
                    "path": path, "type": "thumbnail",
                    "width": Int(thumbnail.cgImage.width), "height": Int(thumbnail.cgImage.height),
                    "scale": Int(scale), "format": formatName, "bytes": data.count,
                    "dataUrl": dataUrl,
                ]))
            }
        }
    }

    private func encode(_ image: NSImage, format: String) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        switch format {
        case "jpeg": return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        case "heic":
            // ImageIO heic export
            guard let cg = rep.cgImage else { return nil }
            let mutable = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(mutable, "public.heic" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            return mutable as Data
        default:
            return rep.representation(using: .png, properties: [:])
        }
    }

    private func batch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let paths = action["paths"] as? [String], !paths.isEmpty else {
            completion(WireFormat.error("thumbnail.batch: requires <paths>")); return
        }
        // Accumulate via a Sendable box so Swift 6 concurrency is satisfied.
        final class Accumulator: @unchecked Sendable {
            let lock = NSLock()
            var results: [[String: Any]]
            init(count: Int) { results = [[String: Any]](repeating: [:], count: count) }
        }
        let acc = Accumulator(count: paths.count)
        let group = DispatchGroup()
        for (idx, p) in paths.enumerated() {
            group.enter()
            var fwd = action
            fwd["path"] = p
            generate(fwd) { resp in
                acc.lock.lock()
                acc.results[idx] = ["path": p, "ok": (resp["success"] as? Bool) ?? false, "result": resp]
                acc.lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global()) {
            completion(WireFormat.success(["results": acc.results]))
        }
    }
}
