import AppKit
import Foundation
import ImageIO
import MarkdownEngine
import UniformTypeIdentifiers

/// Resolves Markdown image destinations against the document's directory.
/// Network URLs are deliberately rejected; remote images are disabled by
/// default throughout Markedown.
final class LocalMarkdownImageProvider: EmbeddedImageProvider, @unchecked Sendable {
    static let defaultMaximumPixelSize = 2_048

    private struct State {
        var documentURL: URL?
        var revision: UInt64 = 0
    }

    private let lock = NSLock()
    private let cache = NSCache<NSString, NSImage>()
    private let maximumPixelSize: Int
    private var state = State()

    init(
        maximumPixelSize: Int = defaultMaximumPixelSize,
        cacheCostLimit: Int = 128 * 1_024 * 1_024
    ) {
        precondition(maximumPixelSize > 0)
        self.maximumPixelSize = maximumPixelSize
        cache.totalCostLimit = cacheCostLimit
    }

    func update(documentURL: URL?, invalidate: Bool = false) {
        var shouldInvalidate = false
        lock.lock()
        if state.documentURL != documentURL || invalidate {
            state.documentURL = documentURL
            state.revision &+= 1
            shouldInvalidate = true
        }
        lock.unlock()

        if shouldInvalidate {
            cache.removeAllObjects()
        }
    }

    func image(for reference: EmbeddedImageRequest) -> NSImage? {
        guard let url = resolvedURL(for: reference.name) else { return nil }
        let key = cacheKey(for: url)
        if let cached = cache.object(forKey: key) {
            return cached
        }

        guard let loaded = loadImage(at: url) else { return nil }
        cache.setObject(loaded.image, forKey: key, cost: loaded.cost)
        return loaded.image
    }

    func fingerprint() -> AnyHashable {
        lock.lock()
        defer { lock.unlock() }
        return AnyHashable("\(state.documentURL?.path(percentEncoded: false) ?? "untitled")#\(state.revision)")
    }

    private func resolvedURL(for rawDestination: String) -> URL? {
        let snapshot: URL? = {
            lock.lock()
            defer { lock.unlock() }
            return state.documentURL
        }()

        var destination = rawDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        if destination.hasPrefix("<"), destination.hasSuffix(">"), destination.count >= 2 {
            destination.removeFirst()
            destination.removeLast()
        }
        destination = destination.removingPercentEncoding ?? destination

        if let parsed = URL(string: destination), let scheme = parsed.scheme?.lowercased() {
            guard scheme == "file" else { return nil }
            return parsed.standardizedFileURL
        }

        if destination.hasPrefix("/") {
            return URL(fileURLWithPath: destination).standardizedFileURL
        }

        guard let baseURL = snapshot?.deletingLastPathComponent() else { return nil }
        let pathOnly = destination.split(separator: "#", maxSplits: 1).first.map(String.init) ?? destination
        return baseURL.appending(path: pathOnly).standardizedFileURL
    }

    private func cacheKey(for url: URL) -> NSString {
        let values = try? url.resourceValues(forKeys: [
            .contentModificationDateKey,
            .fileSizeKey,
        ])
        let modificationBits = values?.contentModificationDate?
            .timeIntervalSinceReferenceDate.bitPattern ?? 0
        let fileSize = values?.fileSize ?? -1
        return "\(url.path(percentEncoded: false))#\(modificationBits)#\(fileSize)#\(maximumPixelSize)" as NSString
    }

    private func loadImage(at url: URL) -> (image: NSImage, cost: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return NSImage(contentsOf: url).map { ($0, 0) }
        }

        // Preserve animated formats. Static raster images take the thumbnail
        // path below so scrolling never decodes their full pixel payload.
        if CGImageSourceGetCount(source) > 1 {
            return NSImage(contentsOf: url).map { ($0, 0) }
        }

        let sourceSize = Self.orientedPixelSize(of: source)
        let needsDownsampling = max(sourceSize.width, sourceSize.height) > CGFloat(maximumPixelSize)
        let options: [CFString: Any] = needsDownsampling
            ? [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            : [
                kCGImageSourceShouldCache: true,
                kCGImageSourceShouldCacheImmediately: true,
            ]

        let cgImage = needsDownsampling
            ? CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            : CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
        guard let cgImage else {
            return NSImage(contentsOf: url).map { ($0, 0) }
        }

        let logicalSize = sourceSize.width > 0 && sourceSize.height > 0
            ? sourceSize
            : CGSize(width: cgImage.width, height: cgImage.height)
        let image = NSImage(size: logicalSize)
        image.addRepresentation(NSBitmapImageRep(cgImage: cgImage))
        return (image, cgImage.bytesPerRow * cgImage.height)
    }

    private static func orientedPixelSize(of source: CGImageSource) -> CGSize {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
            as? [CFString: Any],
            let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
            let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue else {
            return .zero
        }

        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if 5...8 ~= orientation {
            return CGSize(width: height, height: width)
        }
        return CGSize(width: width, height: height)
    }
}

@MainActor
final class MarkdownImageAssetStore {
    final class PromisedFileCollector: @unchecked Sendable {
        private struct ReceiverState {
            var files: [URL] = []
            var callbackCount = 0
            var expectedCallbackCount: Int?
            var expectedFileNames: [String] = []
        }

        typealias Finish = @Sendable ([URL]) -> Void

        private let lock = NSLock()
        private var receivers: [ReceiverState]
        private var isArmed = false
        private var didFinish = false
        private var finish: Finish?

        init(receiverCount: Int) {
            receivers = Array(repeating: ReceiverState(), count: receiverCount)
        }

        func configureReceiver(
            at index: Int,
            expectedFileNames: [String],
            fallbackCount: Int
        ) {
            let pendingFinish: (Finish, [URL])?
            lock.lock()
            receivers[index].expectedFileNames = expectedFileNames
            receivers[index].expectedCallbackCount = max(expectedFileNames.count, fallbackCount, 1)
            pendingFinish = takeFinishIfReadyLocked()
            lock.unlock()
            if let pendingFinish {
                pendingFinish.0(pendingFinish.1)
            }
        }

        func record(_ url: URL?, forReceiverAt index: Int) {
            let pendingFinish: (Finish, [URL])?
            lock.lock()
            receivers[index].callbackCount += 1
            if let url {
                receivers[index].files.append(url)
            }
            pendingFinish = takeFinishIfReadyLocked()
            lock.unlock()
            if let pendingFinish {
                pendingFinish.0(pendingFinish.1)
            }
        }

        func arm(finish: @escaping Finish) {
            let pendingFinish: (Finish, [URL])?
            lock.lock()
            self.finish = finish
            isArmed = true
            pendingFinish = takeFinishIfReadyLocked()
            lock.unlock()
            if let pendingFinish {
                pendingFinish.0(pendingFinish.1)
            }
        }

        private func takeFinishIfReadyLocked() -> (Finish, [URL])? {
            guard isArmed,
                  !didFinish,
                  receivers.allSatisfy({ state in
                      guard let expected = state.expectedCallbackCount else { return false }
                      return state.callbackCount >= expected
                  }),
                  let finish else {
                return nil
            }

            didFinish = true
            self.finish = nil
            return (finish, orderedFilesLocked())
        }

        private func orderedFilesLocked() -> [URL] {
            receivers.flatMap { state in
                guard !state.expectedFileNames.isEmpty else { return state.files }
                var remaining = state.files
                var ordered: [URL] = []
                ordered.reserveCapacity(remaining.count)
                for expectedName in state.expectedFileNames {
                    guard let index = remaining.firstIndex(where: {
                        $0.lastPathComponent == expectedName
                    }) else { continue }
                    ordered.append(remaining.remove(at: index))
                }
                ordered.append(contentsOf: remaining)
                return ordered
            }
        }
    }

    private final class PromiseLifetime: @unchecked Sendable {
        let receivers: [NSFilePromiseReceiver]
        let operationQueue: OperationQueue

        init(receivers: [NSFilePromiseReceiver], operationQueue: OperationQueue) {
            self.receivers = receivers
            self.operationQueue = operationQueue
        }
    }

    private final class CompletionBox: @unchecked Sendable {
        private let completion: ([String]) -> Void

        init(_ completion: @escaping ([String]) -> Void) {
            self.completion = completion
        }

        @MainActor
        func callAsFunction(_ markdown: [String]) {
            completion(markdown)
        }
    }

    private let provider: LocalMarkdownImageProvider
    private(set) var documentURL: URL?

    private static let importQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.zhuanz.markedown.image-import"
        queue.qualityOfService = .userInitiated
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    init(provider: LocalMarkdownImageProvider, documentURL: URL?) {
        self.provider = provider
        self.documentURL = documentURL
        provider.update(documentURL: documentURL)
    }

    func update(documentURL: URL?) {
        self.documentURL = documentURL
        provider.update(documentURL: documentURL)
    }

    /// Imports every image represented by a paste or drop operation.
    ///
    /// The return value reports whether the pasteboard was claimed as an
    /// image operation. File promises (as used by Photos) finish through the
    /// completion asynchronously. File access and asset writes run off the main
    /// thread so importing a batch does not block editing or scrolling.
    @discardableResult
    func importImages(
        from pasteboard: NSPasteboard,
        completion: @escaping ([String]) -> Void
    ) -> Bool {
        let promiseReceivers = PasteboardImageReader.filePromiseReceivers(from: pasteboard)
        if !promiseReceivers.isEmpty {
            guard let targetDocumentURL = documentURL else {
                completion([])
                return true
            }
            receivePromisedImages(
                promiseReceivers,
                targetDocumentURL: targetDocumentURL,
                completion: completion
            )
            return true
        }

        let itemCount = pasteboard.pasteboardItems?.count ?? 0
        let fileURLs = PasteboardImageReader.imageFileURLs(from: pasteboard)
        let canStreamFiles = itemCount > 0
            && fileURLs.count == itemCount
            && fileURLs.allSatisfy { Self.imageFileExtension(at: $0) != nil }
        let representations: [PasteboardImageRepresentation]
        if canStreamFiles {
            representations = []
        } else {
            representations = PasteboardImageReader.imageRepresentations(from: pasteboard)
        }
        guard !fileURLs.isEmpty || !representations.isEmpty else { return false }
        guard let targetDocumentURL = documentURL else {
            completion([])
            return true
        }

        let completionBox = CompletionBox(completion)
        let importQueue = Self.importQueue
        importQueue.addOperation { [weak self] in
            let markdown = canStreamFiles
                ? Self.importFiles(fileURLs, intoDocumentAt: targetDocumentURL)
                : Self.importRepresentations(representations, intoDocumentAt: targetDocumentURL)
            Task { @MainActor [weak self] in
                self?.finishImport(
                    markdown,
                    targetDocumentURL: targetDocumentURL,
                    completion: completionBox
                ) ?? completionBox([])
            }
        }
        return true
    }

    func importImage(from pasteboard: NSPasteboard) -> String? {
        guard let targetDocumentURL = documentURL else { return nil }
        let fileURLs = PasteboardImageReader.imageFileURLs(from: pasteboard)
        let markdown: [String]
        if !fileURLs.isEmpty {
            markdown = Self.importFiles(fileURLs, intoDocumentAt: targetDocumentURL)
        } else {
            markdown = Self.importRepresentations(
                PasteboardImageReader.imageRepresentations(from: pasteboard),
                intoDocumentAt: targetDocumentURL
            )
        }
        if !markdown.isEmpty {
            provider.update(documentURL: targetDocumentURL, invalidate: true)
        }
        return markdown.first
    }

    func importImage(at sourceURL: URL) -> String? {
        guard let targetDocumentURL = documentURL else { return nil }
        let markdown = Self.importFiles([sourceURL], intoDocumentAt: targetDocumentURL)
        if !markdown.isEmpty {
            provider.update(documentURL: targetDocumentURL, invalidate: true)
        }
        return markdown.first
    }

    private func receivePromisedImages(
        _ receivers: [NSFilePromiseReceiver],
        targetDocumentURL: URL,
        completion: @escaping ([String]) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        let stagingURL = FileManager.default.temporaryDirectory
            .appending(path: "MarkedownImagePromises", directoryHint: .isDirectory)
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(
                at: stagingURL,
                withIntermediateDirectories: true
            )
        } catch {
            completion([])
            return
        }

        let collector = PromisedFileCollector(receiverCount: receivers.count)
        let operationQueue = OperationQueue()
        operationQueue.name = "com.zhuanz.markedown.image-file-promises"
        operationQueue.qualityOfService = .userInitiated
        operationQueue.maxConcurrentOperationCount = 1

        let lifetime = PromiseLifetime(receivers: receivers, operationQueue: operationQueue)
        for (index, receiver) in lifetime.receivers.enumerated() {
            receiver.receivePromisedFiles(
                atDestination: stagingURL,
                options: [:],
                operationQueue: operationQueue
            ) { url, error in
                collector.record(error == nil ? url : nil, forReceiverAt: index)
            }
            collector.configureReceiver(
                at: index,
                expectedFileNames: receiver.fileNames,
                fallbackCount: receiver.fileTypes.count
            )
        }

        let importQueue = Self.importQueue
        collector.arm { [weak self, lifetime] promisedFiles in
            _ = lifetime
            importQueue.addOperation { [weak self] in
                let markdown = Self.importFiles(
                    promisedFiles,
                    intoDocumentAt: targetDocumentURL
                )
                try? FileManager.default.removeItem(at: stagingURL)
                Task { @MainActor [weak self] in
                    self?.finishImport(
                        markdown,
                        targetDocumentURL: targetDocumentURL,
                        completion: completionBox
                    ) ?? completionBox([])
                }
            }
        }
    }

    private func finishImport(
        _ markdown: [String],
        targetDocumentURL: URL,
        completion: CompletionBox
    ) {
        guard documentURL == targetDocumentURL else {
            completion([])
            return
        }
        if !markdown.isEmpty {
            provider.update(documentURL: targetDocumentURL, invalidate: true)
        }
        completion(markdown)
    }

    nonisolated private static func importRepresentations(
        _ representations: [PasteboardImageRepresentation],
        intoDocumentAt targetDocumentURL: URL
    ) -> [String] {
        let assetsURL = targetDocumentURL.deletingLastPathComponent()
            .appending(path: "assets", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(
                at: assetsURL,
                withIntermediateDirectories: true
            )
        } catch {
            return []
        }

        var markdown: [String] = []
        markdown.reserveCapacity(representations.count)
        for representation in representations where !representation.data.isEmpty {
            let fileExtension = sanitizedExtension(representation.filenameExtension)
            let destinationURL = uniqueDestinationURL(
                in: assetsURL,
                filenameExtension: fileExtension
            )
            do {
                try representation.data.write(to: destinationURL, options: .atomic)
                markdown.append("![Image](assets/\(destinationURL.lastPathComponent))")
            } catch {
                continue
            }
        }

        return markdown
    }

    nonisolated private static func importFiles(
        _ sourceURLs: [URL],
        intoDocumentAt targetDocumentURL: URL
    ) -> [String] {
        let assetsURL = targetDocumentURL.deletingLastPathComponent()
            .appending(path: "assets", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(
                at: assetsURL,
                withIntermediateDirectories: true
            )
        } catch {
            return []
        }

        var markdown: [String] = []
        markdown.reserveCapacity(sourceURLs.count)
        for sourceURL in sourceURLs {
            guard let fileExtension = imageFileExtension(at: sourceURL) else { continue }
            let destinationURL = uniqueDestinationURL(
                in: assetsURL,
                filenameExtension: fileExtension
            )
            do {
                try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
                markdown.append("![Image](assets/\(destinationURL.lastPathComponent))")
            } catch {
                continue
            }
        }
        return markdown
    }

    nonisolated private static func imageFileExtension(at sourceURL: URL) -> String? {
        guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
              CGImageSourceGetCount(source) > 0 else {
            return nil
        }

        guard let detectedType = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }),
              detectedType.conforms(to: .image) else {
            return nil
        }

        return sanitizedExtension(detectedType.preferredFilenameExtension ?? "png")
    }

    nonisolated private static func sanitizedExtension(_ proposedExtension: String) -> String {
        let value = proposedExtension.lowercased()
        let safe = value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0)
        }
        return safe && !value.isEmpty ? value : "png"
    }

    nonisolated private static func uniqueDestinationURL(
        in assetsURL: URL,
        filenameExtension: String
    ) -> URL {
        while true {
            let filename = "image-\(UUID().uuidString.lowercased()).\(filenameExtension)"
            let candidate = assetsURL.appending(path: filename)
            if !FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
    }
}
