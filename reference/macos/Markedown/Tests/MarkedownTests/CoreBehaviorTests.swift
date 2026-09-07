import Foundation
import XCTest

@testable import Markedown

@MainActor
final class CoreBehaviorTests: XCTestCase {
    func testLargeDocumentThresholdBoundaries() {
        let oneMiB = 1_048_576
        let fiveMiB = 5_242_880

        XCTAssertFalse(DocumentSession(source: String(repeating: "a", count: oneMiB)).prefersSourceMode)
        XCTAssertTrue(DocumentSession(source: String(repeating: "a", count: oneMiB + 1)).prefersSourceMode)
        XCTAssertFalse(DocumentSession(source: String(repeating: "a", count: fiveMiB)).requiresSourceMode)

        let oversized = DocumentSession(source: String(repeating: "a", count: fiveMiB + 1))
        XCTAssertTrue(oversized.requiresSourceMode)
        XCTAssertTrue(oversized.prefersSourceMode)
    }

    func testDocumentOwnershipIsExclusiveAcrossWindows() {
        let runtime = AppRuntime()
        let firstOwner = AppController(runtime: runtime)
        let secondOwner = AppController(runtime: runtime)
        let firstDocument = DocumentID()
        let secondDocument = DocumentID()
        let url = URL(fileURLWithPath: "/tmp/markedown-ownership-test.md")

        XCTAssertTrue(runtime.claimDocument(
            at: url,
            documentID: firstDocument,
            owner: firstOwner
        ))
        XCTAssertFalse(runtime.claimDocument(
            at: url,
            documentID: secondDocument,
            owner: secondOwner
        ))
        XCTAssertFalse(runtime.claimDocument(
            at: url,
            documentID: secondDocument,
            owner: firstOwner
        ))

        runtime.releaseDocument(
            at: url,
            documentID: firstDocument,
            owner: firstOwner
        )
        XCTAssertTrue(runtime.claimDocument(
            at: url,
            documentID: secondDocument,
            owner: secondOwner
        ))
    }

    func testStartupRestorationCanOnlyBeClaimedOnce() {
        let runtime = AppRuntime()
        XCTAssertTrue(runtime.claimStartupRestoration())
        XCTAssertFalse(runtime.claimStartupRestoration())
    }

    func testDroppedDocumentFilteringAcceptsSupportedFilesAndPreservesOrder() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let first = directory.appendingPathComponent("First.MD")
        let second = directory.appendingPathComponent("Second.markdown")
        let text = directory.appendingPathComponent("Notes.txt")
        let image = directory.appendingPathComponent("Cover.png")
        let namedDirectory = directory.appendingPathComponent("Folder.md", isDirectory: true)

        try Data("# First".utf8).write(to: first)
        try Data("# Second".utf8).write(to: second)
        try Data("Notes".utf8).write(to: text)
        try Data().write(to: image)
        try FileManager.default.createDirectory(
            at: namedDirectory,
            withIntermediateDirectories: false
        )

        let accepted = AppController.supportedDroppedDocumentURLs(from: [
            first,
            image,
            URL(string: "https://example.com/Remote.md")!,
            namedDirectory,
            second,
            first.appendingPathComponent("..")
                .appendingPathComponent(first.lastPathComponent),
            text,
        ])

        XCTAssertEqual(accepted, [
            first.standardizedFileURL,
            second.standardizedFileURL,
            text.standardizedFileURL,
        ])
    }

    func testRecoveredDocumentRequiresExplicitSaveBeforeWritingToDisk() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let fileURL = directory.appendingPathComponent("Recovered.md")
        try Data("disk version".utf8).write(to: fileURL)
        let documentStore = DocumentStore()
        let diskSnapshot = try await documentStore.load(from: fileURL)
        let recoveryStore = RecoveryStore(
            baseURL: directory.appendingPathComponent("Recovery", isDirectory: true)
        )
        let documentID = DocumentID()
        try await recoveryStore.save(RecoverySnapshot(
            documentID: documentID,
            url: fileURL,
            source: "recovered version",
            encoding: .utf8,
            lineEnding: .lf,
            revision: diskSnapshot.revision,
            editorMode: .live,
            selectionLocation: 0,
            selectionLength: 0,
            scrollOffset: 0
        ))

        let suiteName = "MarkedownTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set(false, forKey: "settings.rememberWorkspace")
        defaults.set(true, forKey: "settings.autoSave")
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let controller = AppController(
            settings: AppSettings(defaults: defaults),
            runtime: AppRuntime(),
            documentStore: documentStore,
            recoveryStore: recoveryStore
        )
        await controller.start()

        let recovered = try XCTUnwrap(controller.activeDocument)
        XCTAssertEqual(recovered.id, documentID)
        XCTAssertTrue(recovered.isDirty)
        XCTAssertTrue(recovered.requiresExplicitSaveAfterRecovery)

        controller.updateSource("recovered version with edit", for: documentID)
        try await Task.sleep(for: .seconds(1.3))
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "disk version")

        let didSave = await controller.save(recovered)
        XCTAssertTrue(didSave)
        XCTAssertFalse(recovered.requiresExplicitSaveAfterRecovery)
        XCTAssertEqual(
            try String(contentsOf: fileURL, encoding: .utf8),
            "recovered version with edit"
        )
    }

}
