import Foundation
import XCTest
@testable import Markedown

@MainActor
final class WorkspaceStoreTests: XCTestCase {
    func testLazyAndRecursiveScanningOnlyIncludesSupportedDocuments() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        try write("# Root", to: root.appendingPathComponent("Root.md"))
        try write("notes", to: root.appendingPathComponent("Notes.txt"))
        try write("binary", to: root.appendingPathComponent("Image.png"))
        try write("hidden", to: root.appendingPathComponent(".Hidden.md"))

        let nested = root.appendingPathComponent("Nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try write("nested", to: nested.appendingPathComponent("Child.markdown"))

        let package = root.appendingPathComponent("Ignored.app", isDirectory: true)
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        try write("ignored", to: package.appendingPathComponent("Inside.md"))

        let fixture = makeStore()
        defer { fixture.defaults.removePersistentDomain(forName: fixture.suiteName) }
        let workspace = try await fixture.store.openWorkspace(at: root)
        let unloadedRoot = try await fixture.store.rootNode(for: workspace.id)
        XCTAssertNil(unloadedRoot.children)

        let lazyRoot = try await fixture.store.loadChildren(of: unloadedRoot)
        XCTAssertEqual(lazyRoot.children?.map(\.name), ["Nested", "Notes.txt", "Root.md"])
        XCTAssertNil(lazyRoot.children?.first(where: { $0.name == "Nested" })?.children)

        let recursiveRoot = try await fixture.store.scanRecursively(workspace.id)
        let allNames = flattenedNames(in: recursiveRoot)
        XCTAssertTrue(allNames.contains("Child.markdown"))
        XCTAssertFalse(allNames.contains("Inside.md"))
        XCTAssertFalse(allNames.contains(".Hidden.md"))
        XCTAssertFalse(allNames.contains("Image.png"))
    }

    func testBookmarkPersistenceRestoresWorkspaceIdentity() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let fixture = makeStore()
        defer { fixture.defaults.removePersistentDomain(forName: fixture.suiteName) }
        let firstStore = fixture.store
        let opened = try await firstStore.openWorkspace(at: root)
        await firstStore.closeWorkspace(opened.id)

        let restoredStore = WorkspaceStore(
            userDefaultsSuiteName: fixture.suiteName,
            bookmarkKey: fixture.bookmarkKey,
            bookmarkClient: testBookmarkClient
        )
        let restored = try await restoredStore.restoreWorkspaces()

        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(restored.first?.id, opened.id)
        XCTAssertEqual(restored.first?.rootURL.standardizedFileURL, root.standardizedFileURL)
    }

    func testLiteralSearchReturnsOneBasedLineColumnsAndSkipsPackages() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        try write(
            "Alpha beta\nsecond ALPHA alpha\nno match",
            to: root.appendingPathComponent("Document.md")
        )
        let nested = root.appendingPathComponent("Nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try write("prefix alpha suffix", to: nested.appendingPathComponent("Notes.text"))
        try write("alpha", to: root.appendingPathComponent(".Hidden.md"))

        let package = root.appendingPathComponent("Ignored.bundle", isDirectory: true)
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        try write("alpha", to: package.appendingPathComponent("Inside.md"))

        let service = WorkspaceSearchService()
        let results = try await service.search(for: "alpha", in: root)
        let documentResults = results.filter { $0.fileURL.lastPathComponent == "Document.md" }

        XCTAssertEqual(results.count, 4)
        XCTAssertEqual(documentResults.map(\.line), [1, 2, 2])
        XCTAssertEqual(documentResults.map(\.column), [1, 8, 14])
        XCTAssertEqual(documentResults.map(\.preview), [
            "Alpha beta",
            "second ALPHA alpha",
            "second ALPHA alpha"
        ])
    }

    func testSearchObservesCallerCancellation() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try write(String(repeating: "needle ", count: 1_000), to: root.appendingPathComponent("Large.md"))

        let service = WorkspaceSearchService()
        let task = Task { () throws -> [WorkspaceSearchResult] in
            withUnsafeCurrentTask { currentTask in
                currentTask?.cancel()
            }
            return try await service.search(for: "needle", in: root)
        }

        do {
            _ = try await task.value
            XCTFail("A cancelled search should throw CancellationError")
        } catch is CancellationError {
            // Expected.
        }
    }

    private struct StoreFixture {
        let store: WorkspaceStore
        let defaults: UserDefaults
        let suiteName: String
        let bookmarkKey: String
    }

    private var testBookmarkClient: WorkspaceBookmarkClient {
        WorkspaceBookmarkClient(
            create: { url in
                Data(url.standardizedFileURL.path.utf8)
            },
            resolve: { data in
                let path = String(decoding: data, as: UTF8.self)
                return WorkspaceBookmarkResolution(
                    url: URL(fileURLWithPath: path, isDirectory: true),
                    isStale: false
                )
            }
        )
    }

    private func makeStore() -> StoreFixture {
        let suiteName = "Markedown.WorkspaceStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        let bookmarkKey = "workspace-bookmarks"
        return StoreFixture(
            store: WorkspaceStore(
                userDefaultsSuiteName: suiteName,
                bookmarkKey: bookmarkKey,
                bookmarkClient: testBookmarkClient
            ),
            defaults: defaults,
            suiteName: suiteName,
            bookmarkKey: bookmarkKey
        )
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("MarkedownWorkspaceTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func write(_ value: String, to url: URL) throws {
        try value.write(to: url, atomically: true, encoding: .utf8)
    }

    private func flattenedNames(in node: WorkspaceNode) -> [String] {
        [node.name] + (node.children ?? []).flatMap(flattenedNames)
    }
}
