import AppKit
import MarkdownEngine
import XCTest
@testable import Markedown

@MainActor
final class LocalMarkdownImageProviderTests: XCTestCase {
    func testImportImagesPreservesMultipleFileURLOrder() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let documentURL = directory.appendingPathComponent("Document.md")
        try Data().write(to: documentURL)
        let firstData = try makePNG(width: 3, height: 2, color: (0xE1, 0x45, 0x45, 0xFF))
        let secondData = try makePNG(width: 2, height: 3, color: (0x35, 0x82, 0xC4, 0xFF))
        let firstURL = directory.appendingPathComponent("first.png")
        let secondURL = directory.appendingPathComponent("second.png")
        try firstData.write(to: firstURL)
        try secondData.write(to: secondURL)

        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([firstURL as NSURL, secondURL as NSURL]))
        let store = MarkdownImageAssetStore(
            provider: LocalMarkdownImageProvider(),
            documentURL: documentURL
        )

        var imported: [String]?
        let completed = expectation(description: "batch file import completed")
        let handled = store.importImages(from: pasteboard) {
            imported = $0
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 2)
        let markdown = try XCTUnwrap(imported)

        XCTAssertTrue(handled)
        XCTAssertEqual(markdown.count, 2)
        let importedURLs = try markdown.map { try importedImageURL(from: $0, documentURL: documentURL) }
        XCTAssertNotEqual(importedURLs[0], importedURLs[1])
        XCTAssertEqual(try Data(contentsOf: importedURLs[0]), firstData)
        XCTAssertEqual(try Data(contentsOf: importedURLs[1]), secondData)
    }

    func testImportImagesPreservesMultipleRawPasteboardItemsAndUsesUniqueNames() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let documentURL = directory.appendingPathComponent("Document.md")
        try Data().write(to: documentURL)
        let firstData = try makePNG(width: 4, height: 2, color: (0x52, 0xA4, 0x67, 0xFF))
        let secondData = try makePNG(width: 2, height: 4, color: (0xD0, 0x91, 0x32, 0xFF))
        let firstItem = NSPasteboardItem()
        let secondItem = NSPasteboardItem()
        XCTAssertTrue(firstItem.setData(firstData, forType: .png))
        XCTAssertTrue(secondItem.setData(secondData, forType: .png))
        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([firstItem, secondItem]))
        let store = MarkdownImageAssetStore(
            provider: LocalMarkdownImageProvider(),
            documentURL: documentURL
        )

        var imported: [String]?
        let completed = expectation(description: "batch data import completed")
        let handled = store.importImages(from: pasteboard) {
            imported = $0
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 2)
        let markdown = try XCTUnwrap(imported)

        XCTAssertTrue(handled)
        XCTAssertEqual(markdown.count, 2)
        let importedURLs = try markdown.map { try importedImageURL(from: $0, documentURL: documentURL) }
        XCTAssertNotEqual(importedURLs[0].lastPathComponent, importedURLs[1].lastPathComponent)
        XCTAssertEqual(try Data(contentsOf: importedURLs[0]), firstData)
        XCTAssertEqual(try Data(contentsOf: importedURLs[1]), secondData)
    }

    func testInvalidImageFileURLFallsBackToInlineData() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let documentURL = directory.appendingPathComponent("Document.md")
        try Data().write(to: documentURL)
        let inlineData = try makePNG(width: 3, height: 2, color: (0x6A, 0x8F, 0xD3, 0xFF))
        let missingURL = directory.appendingPathComponent("missing.heic")
        let item = NSPasteboardItem()
        XCTAssertTrue(item.setString(missingURL.absoluteString, forType: .fileURL))
        XCTAssertTrue(item.setData(inlineData, forType: .png))
        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([item]))
        let store = MarkdownImageAssetStore(
            provider: LocalMarkdownImageProvider(),
            documentURL: documentURL
        )

        var imported: [String]?
        let completed = expectation(description: "inline fallback import completed")
        let handled = store.importImages(from: pasteboard) {
            imported = $0
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 2)

        XCTAssertTrue(handled)
        let markdown = try XCTUnwrap(imported)
        XCTAssertEqual(markdown.count, 1)
        let importedURL = try importedImageURL(from: markdown[0], documentURL: documentURL)
        XCTAssertEqual(try Data(contentsOf: importedURL), inlineData)
    }

    func testImagePasteboardIsClaimedWhenDocumentHasNoURL() throws {
        let data = try makePNG(width: 2, height: 2)
        let item = NSPasteboardItem()
        XCTAssertTrue(item.setData(data, forType: .png))
        let pasteboard = makePasteboard()
        XCTAssertTrue(pasteboard.writeObjects([item]))
        let store = MarkdownImageAssetStore(
            provider: LocalMarkdownImageProvider(),
            documentURL: nil
        )

        var imported: [String]?
        let handled = store.importImages(from: pasteboard) { imported = $0 }

        XCTAssertTrue(handled)
        XCTAssertEqual(imported, [])
    }

    func testNonImagePasteboardIsNotClaimed() {
        let pasteboard = makePasteboard()
        pasteboard.setString("ordinary text", forType: .string)
        let store = MarkdownImageAssetStore(
            provider: LocalMarkdownImageProvider(),
            documentURL: nil
        )

        var didComplete = false
        let handled = store.importImages(from: pasteboard) { _ in didComplete = true }

        XCTAssertFalse(handled)
        XCTAssertFalse(didComplete)
    }

    func testPromiseCollectorWaitsForEveryReceiverAndPreservesDeclaredOrder() {
        let collector = MarkdownImageAssetStore.PromisedFileCollector(receiverCount: 2)
        let firstURL = URL(fileURLWithPath: "/tmp/first.png")
        let secondURL = URL(fileURLWithPath: "/tmp/second.png")
        let result = PromiseCollectionProbe()
        let completed = expectation(description: "all promise callbacks collected")
        completed.assertForOverFulfill = true

        collector.configureReceiver(
            at: 0,
            expectedFileNames: ["first.png"],
            fallbackCount: 1
        )
        collector.configureReceiver(
            at: 1,
            expectedFileNames: ["second.png"],
            fallbackCount: 1
        )
        collector.arm { urls in
            result.record(urls)
            completed.fulfill()
        }

        XCTAssertEqual(result.completionCount, 0)
        collector.record(secondURL, forReceiverAt: 1)
        XCTAssertEqual(result.completionCount, 0)
        collector.record(firstURL, forReceiverAt: 0)
        wait(for: [completed], timeout: 1)

        XCTAssertEqual(result.completionCount, 1)
        XCTAssertEqual(result.latestURLs, [firstURL, secondURL])
        collector.record(nil, forReceiverAt: 0)
        XCTAssertEqual(result.completionCount, 1)
    }

    func testLargeStaticImageIsDownsampledAndCachedWithoutChangingLogicalSize() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let documentURL = directory.appendingPathComponent("Document.md")
        let imageURL = directory.appendingPathComponent("large.png")
        try Data("![Large](large.png)".utf8).write(to: documentURL)
        try makePNG(width: 1_024, height: 256).write(to: imageURL)

        let provider = LocalMarkdownImageProvider(maximumPixelSize: 128)
        provider.update(documentURL: documentURL)
        let request = EmbeddedImageRequest(name: "large.png")

        let first = try XCTUnwrap(provider.image(for: request))
        let second = try XCTUnwrap(provider.image(for: request))
        let representation = try XCTUnwrap(first.representations.first)

        XCTAssertTrue(first === second)
        XCTAssertLessThanOrEqual(max(representation.pixelsWide, representation.pixelsHigh), 128)
        XCTAssertEqual(first.size.width, 1_024, accuracy: 0.5)
        XCTAssertEqual(first.size.height, 256, accuracy: 0.5)

        provider.update(documentURL: documentURL, invalidate: true)
        let reloaded = try XCTUnwrap(provider.image(for: request))
        XCTAssertFalse(first === reloaded)
    }

    func testSmallStaticImageKeepsItsNativePixelDimensions() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let documentURL = directory.appendingPathComponent("Document.md")
        let imageURL = directory.appendingPathComponent("small.png")
        try Data().write(to: documentURL)
        try makePNG(width: 64, height: 32).write(to: imageURL)

        let provider = LocalMarkdownImageProvider(maximumPixelSize: 128)
        provider.update(documentURL: documentURL)
        let image = try XCTUnwrap(provider.image(
            for: EmbeddedImageRequest(name: imageURL.absoluteString)
        ))
        let representation = try XCTUnwrap(image.representations.first)

        XCTAssertEqual(representation.pixelsWide, 64)
        XCTAssertEqual(representation.pixelsHigh, 32)
        XCTAssertEqual(image.size, NSSize(width: 64, height: 32))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func makePasteboard() -> NSPasteboard {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("MarkedownTests-\(UUID().uuidString)"))
        pasteboard.clearContents()
        return pasteboard
    }

    private func importedImageURL(from markdown: String, documentURL: URL) throws -> URL {
        let prefix = "![Image]("
        guard markdown.hasPrefix(prefix), markdown.hasSuffix(")") else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let relativePath = String(markdown.dropFirst(prefix.count).dropLast())
        return documentURL.deletingLastPathComponent().appendingPathComponent(relativePath)
    }

    private func makePNG(
        width: Int,
        height: Int,
        color: (UInt8, UInt8, UInt8, UInt8) = (0x7F, 0xA0, 0xC0, 0xFF)
    ) throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ))
        if let bitmapData = bitmap.bitmapData {
            for y in 0..<height {
                for x in 0..<width {
                    let offset = y * bitmap.bytesPerRow + x * 4
                    bitmapData[offset] = color.0
                    bitmapData[offset + 1] = color.1
                    bitmapData[offset + 2] = color.2
                    bitmapData[offset + 3] = color.3
                }
            }
        }
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }
}

private final class PromiseCollectionProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var batches: [[URL]] = []

    func record(_ urls: [URL]) {
        lock.lock()
        batches.append(urls)
        lock.unlock()
    }

    var completionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return batches.count
    }

    var latestURLs: [URL]? {
        lock.lock()
        defer { lock.unlock() }
        return batches.last
    }
}
