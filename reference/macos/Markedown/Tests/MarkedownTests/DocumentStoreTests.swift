import Foundation
import XCTest
@testable import Markedown

@MainActor
final class DocumentStoreTests: XCTestCase {
    func testUneditedDocumentsRoundTripByteForByte() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        var bomCRLF = Data([0xEF, 0xBB, 0xBF])
        bomCRLF.append(contentsOf: "标题\r\nEmoji 😀\r\ne\u{301}".utf8)
        let fixtures = [
            Data("标题\nEmoji 😀\ne\u{301}".utf8),
            bomCRLF,
        ]
        let store = DocumentStore()

        for (index, originalData) in fixtures.enumerated() {
            let fileURL = directoryURL.appendingPathComponent("roundtrip-\(index).md")
            try originalData.write(to: fileURL)
            let loaded = try await store.load(from: fileURL)

            _ = try await store.save(
                source: loaded.source,
                to: fileURL,
                encoding: loaded.encoding,
                lineEnding: loaded.lineEnding,
                expectedRevision: loaded.revision
            )

            XCTAssertEqual(try Data(contentsOf: fileURL), originalData)
        }
    }

    func testLoadDetectsUTF8BOMAndCRLFAndNormalizesSource() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("document.md")
        var data = Data([0xEF, 0xBB, 0xBF])
        data.append(contentsOf: "first\r\nsecond\r\n".utf8)
        try data.write(to: fileURL)

        let snapshot = try await DocumentStore().load(from: fileURL)

        XCTAssertEqual(snapshot.source, "first\nsecond\n")
        XCTAssertEqual(snapshot.encoding, .utf8WithBOM)
        XCTAssertEqual(snapshot.lineEnding, .crlf)
        XCTAssertEqual(snapshot.revision.fileSize, Int64(data.count))
        XCTAssertEqual(snapshot.url, fileURL.standardizedFileURL)
    }

    func testLoadComputesSHA256Revision() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("digest.md")
        try Data("abc".utf8).write(to: fileURL)

        let snapshot = try await DocumentStore().load(from: fileURL)

        XCTAssertEqual(
            snapshot.revision.contentDigest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        XCTAssertEqual(snapshot.revision.fileSize, 3)
    }

    func testLoadRejectsInvalidUTF8() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("invalid.md")
        try Data([0xFF, 0xFE, 0x00, 0x00]).write(to: fileURL)

        do {
            _ = try await DocumentStore().load(from: fileURL)
            XCTFail("Expected invalid UTF-8 to be rejected.")
        } catch let error as DocumentStoreError {
            guard case .unsupportedEncoding(let errorURL) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(errorURL, fileURL.standardizedFileURL)
        }
    }

    func testSaveRejectsDirectoryDestination() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        do {
            _ = try await DocumentStore().save(
                source: "content",
                to: directoryURL,
                encoding: .utf8,
                lineEnding: .lf,
                expectedRevision: nil
            )
            XCTFail("Expected a directory destination to be rejected.")
        } catch let error as DocumentStoreError {
            guard case .notRegularFile(let errorURL) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(errorURL, directoryURL.standardizedFileURL)
        }
    }

    func testSaveWritesRequestedBOMAndCRLF() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("saved.md")
        let store = DocumentStore()
        let snapshot = try await store.save(
            source: "first\nsecond\n",
            to: fileURL,
            encoding: .utf8WithBOM,
            lineEnding: .crlf,
            expectedRevision: nil
        )

        let data = try Data(contentsOf: fileURL)
        XCTAssertTrue(data.starts(with: [0xEF, 0xBB, 0xBF]))
        XCTAssertEqual(String(data: data.dropFirst(3), encoding: .utf8), "first\r\nsecond\r\n")
        XCTAssertEqual(snapshot.source, "first\nsecond\n")
        XCTAssertEqual(snapshot.encoding, .utf8WithBOM)
        XCTAssertEqual(snapshot.lineEnding, .crlf)
        let currentRevision = try await store.revision(for: fileURL)
        XCTAssertEqual(currentRevision, snapshot.revision)

        let leftoverFiles = try FileManager.default.contentsOfDirectory(
            atPath: directoryURL.path
        ).filter { $0.contains("markedown-save") }
        XCTAssertTrue(leftoverFiles.isEmpty)
    }

    func testSaveRejectsRevisionConflictWithoutOverwritingExternalChanges() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("conflict.md")
        let store = DocumentStore()
        let initialSnapshot = try await store.save(
            source: "initial",
            to: fileURL,
            encoding: .utf8,
            lineEnding: .lf,
            expectedRevision: nil
        )
        try Data("external".utf8).write(to: fileURL, options: .atomic)

        do {
            _ = try await store.save(
                source: "editor",
                to: fileURL,
                encoding: .utf8,
                lineEnding: .lf,
                expectedRevision: initialSnapshot.revision
            )
            XCTFail("Expected a revision conflict.")
        } catch let error as DocumentStoreError {
            guard case .revisionConflict(let errorURL, let expected, let actual) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(errorURL, fileURL.standardizedFileURL)
            XCTAssertEqual(expected, initialSnapshot.revision)
            XCTAssertNotEqual(actual, initialSnapshot.revision)
        }

        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "external")
    }

    func testConflictDetectionUsesDigestWhenSizeMatches() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("digest-conflict.md")
        let store = DocumentStore()
        let initial = try await store.save(
            source: "initial",
            to: fileURL,
            encoding: .utf8,
            lineEnding: .lf,
            expectedRevision: nil
        )
        try Data("outside".utf8).write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.modificationDate: initial.revision.modificationDate],
            ofItemAtPath: fileURL.path
        )

        do {
            _ = try await store.save(
                source: "editor!",
                to: fileURL,
                encoding: .utf8,
                lineEnding: .lf,
                expectedRevision: initial.revision
            )
            XCTFail("Expected digest mismatch to produce a conflict.")
        } catch let error as DocumentStoreError {
            guard case .revisionConflict(_, let expected, let actual) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(expected?.fileSize, actual?.fileSize)
            XCTAssertNotEqual(expected?.contentDigest, actual?.contentDigest)
        }
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "outside")
    }

    func testLoad350KCharactersWithinTwoSeconds() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let source = String(repeating: "段落 markdown text\n", count: 22_000)
        XCTAssertGreaterThanOrEqual(source.count, 350_000)
        let fileURL = directoryURL.appendingPathComponent("large.md")
        try Data(source.utf8).write(to: fileURL)

        let clock = ContinuousClock()
        let startedAt = clock.now
        let snapshot = try await DocumentStore().load(from: fileURL)
        let elapsed = startedAt.duration(to: clock.now)

        XCTAssertEqual(snapshot.source, source)
        XCTAssertLessThan(elapsed, .seconds(2))
    }

    func testSaveWithMatchingRevisionAtomicallyReplacesExistingFile() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("replace.md")
        let store = DocumentStore()
        let initialSnapshot = try await store.save(
            source: "initial\n",
            to: fileURL,
            encoding: .utf8,
            lineEnding: .lf,
            expectedRevision: nil
        )

        let updatedSnapshot = try await store.save(
            source: "updated\n",
            to: fileURL,
            encoding: .utf8WithBOM,
            lineEnding: .crlf,
            expectedRevision: initialSnapshot.revision
        )

        XCTAssertEqual(updatedSnapshot.source, "updated\n")
        XCTAssertEqual(updatedSnapshot.encoding, .utf8WithBOM)
        XCTAssertEqual(updatedSnapshot.lineEnding, .crlf)
        XCTAssertNotEqual(updatedSnapshot.revision, initialSnapshot.revision)
    }

    func testExpectedRevisionConflictsWhenFileWasDeleted() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let fileURL = directoryURL.appendingPathComponent("deleted.md")
        let store = DocumentStore()
        let initialSnapshot = try await store.save(
            source: "initial",
            to: fileURL,
            encoding: .utf8,
            lineEnding: .lf,
            expectedRevision: nil
        )
        try FileManager.default.removeItem(at: fileURL)

        do {
            _ = try await store.save(
                source: "editor",
                to: fileURL,
                encoding: .utf8,
                lineEnding: .lf,
                expectedRevision: initialSnapshot.revision
            )
            XCTFail("Expected a revision conflict.")
        } catch let error as DocumentStoreError {
            guard case .revisionConflict(_, let expected, let actual) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(expected, initialSnapshot.revision)
            XCTAssertNil(actual)
        }
    }

    func testRecoverySnapshotRoundTripsAndDeletes() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let store = RecoveryStore(baseURL: directoryURL.appendingPathComponent("Recovery"))
        let snapshot = RecoverySnapshot(
            documentID: DocumentID(UUID(uuidString: "DDB6C96F-5D8A-4D35-8D1E-214623797BED")!),
            url: directoryURL.appendingPathComponent("draft.md"),
            source: "# Recovered\n",
            encoding: .utf8WithBOM,
            lineEnding: .crlf,
            revision: nil,
            editorMode: .source,
            selectionLocation: 3,
            selectionLength: 7,
            scrollOffset: 42.5,
            savedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try await store.save(snapshot)
        let updatedSnapshot = RecoverySnapshot(
            documentID: snapshot.documentID,
            url: snapshot.url,
            source: "# Updated recovery\n",
            encoding: snapshot.encoding,
            lineEnding: snapshot.lineEnding,
            revision: snapshot.revision,
            editorMode: snapshot.editorMode,
            selectionLocation: 5,
            selectionLength: 2,
            scrollOffset: 84,
            savedAt: snapshot.savedAt.addingTimeInterval(1)
        )
        try await store.save(updatedSnapshot)
        let loadedSnapshot = try await store.load(for: snapshot.documentID)
        let allSnapshots = try await store.loadAll()
        XCTAssertEqual(loadedSnapshot, updatedSnapshot)
        XCTAssertEqual(allSnapshots, [updatedSnapshot])

        try await store.delete(for: snapshot.documentID)
        let deletedSnapshot = try await store.load(for: snapshot.documentID)
        XCTAssertNil(deletedSnapshot)
        try await store.delete(for: snapshot.documentID)
    }

    func testRecoveryLoadAllSortsNewestFirst() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let store = RecoveryStore(baseURL: directoryURL.appendingPathComponent("Recovery"))
        let older = makeRecoverySnapshot(
            documentID: DocumentID(UUID(uuidString: "17F49DBB-05D7-4E0E-BCC5-90BD5A9AFD01")!),
            source: "older",
            savedAt: Date(timeIntervalSince1970: 100)
        )
        let newer = makeRecoverySnapshot(
            documentID: DocumentID(UUID(uuidString: "C9266645-2BF2-4E54-8235-EFBA2CA7AD25")!),
            source: "newer",
            savedAt: Date(timeIntervalSince1970: 200)
        )

        try await store.save(older)
        try await store.save(newer)

        let allSnapshots = try await store.loadAll()
        XCTAssertEqual(allSnapshots, [newer, older])
    }

    func testRecoveryStoreReportsCorruptSnapshot() async throws {
        let directoryURL = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directoryURL) }

        let recoveryURL = directoryURL.appendingPathComponent("Recovery")
        try FileManager.default.createDirectory(at: recoveryURL, withIntermediateDirectories: true)
        let documentID = DocumentID()
        let snapshotURL = recoveryURL.appendingPathComponent(
            "\(documentID.rawValue.uuidString.lowercased()).json"
        )
        try Data("not-json".utf8).write(to: snapshotURL)

        do {
            _ = try await RecoveryStore(baseURL: recoveryURL).load(for: documentID)
            XCTFail("Expected a corrupt recovery snapshot error.")
        } catch let error as RecoveryStoreError {
            guard case .corruptSnapshot(let errorURL, _) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(errorURL, snapshotURL)
        }
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("Markedown-DocumentStoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeRecoverySnapshot(
        documentID: DocumentID,
        source: String,
        savedAt: Date
    ) -> RecoverySnapshot {
        RecoverySnapshot(
            documentID: documentID,
            url: nil,
            source: source,
            encoding: .utf8,
            lineEnding: .lf,
            revision: nil,
            savedAt: savedAt
        )
    }
}
