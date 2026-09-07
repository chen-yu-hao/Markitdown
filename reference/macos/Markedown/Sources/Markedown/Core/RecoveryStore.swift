import Foundation

struct RecoverySnapshot: Codable, Hashable, Identifiable, Sendable {
    let documentID: DocumentID
    let url: URL?
    let source: String
    let encoding: DocumentEncoding
    let lineEnding: LineEnding
    let revision: DocumentRevision?
    let editorMode: EditorMode
    let selectionLocation: Int
    let selectionLength: Int
    let scrollOffset: Double
    let savedAt: Date

    var id: DocumentID { documentID }

    init(
        documentID: DocumentID,
        url: URL?,
        source: String,
        encoding: DocumentEncoding,
        lineEnding: LineEnding,
        revision: DocumentRevision?,
        editorMode: EditorMode = .live,
        selectionLocation: Int = 0,
        selectionLength: Int = 0,
        scrollOffset: Double = 0,
        savedAt: Date = .now
    ) {
        self.documentID = documentID
        self.url = url
        self.source = source
        self.encoding = encoding
        self.lineEnding = lineEnding
        self.revision = revision
        self.editorMode = editorMode
        self.selectionLocation = selectionLocation
        self.selectionLength = selectionLength
        self.scrollOffset = scrollOffset
        self.savedAt = savedAt
    }
}

enum RecoveryStoreError: Error, Equatable, LocalizedError, Sendable {
    case directoryCreationFailed(URL, reason: String)
    case encodingFailed(DocumentID, reason: String)
    case readFailed(URL, reason: String)
    case corruptSnapshot(URL, reason: String)
    case writeFailed(URL, reason: String)
    case deletionFailed(URL, reason: String)

    var errorDescription: String? {
        switch self {
        case .directoryCreationFailed(let url, let reason):
            localizedFormat("error.recovery.directory-create-failed", url.path, reason)
        case .encodingFailed(let documentID, let reason):
            localizedFormat("error.recovery.encoding-failed", documentID.rawValue.uuidString, reason)
        case .readFailed(let url, let reason):
            localizedFormat("error.recovery.read-failed", url.path, reason)
        case .corruptSnapshot(let url, let reason):
            localizedFormat("error.recovery.corrupt", url.path, reason)
        case .writeFailed(let url, let reason):
            localizedFormat("error.recovery.write-failed", url.path, reason)
        case .deletionFailed(let url, let reason):
            localizedFormat("error.recovery.delete-failed", url.path, reason)
        }
    }
}

actor RecoveryStore {
    let baseURL: URL

    init(baseURL: URL? = nil) {
        self.baseURL = (baseURL ?? Self.defaultBaseURL()).standardizedFileURL
    }

    func save(_ snapshot: RecoverySnapshot) throws {
        try ensureBaseDirectoryExists()

        let data: Data
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            data = try encoder.encode(snapshot)
        } catch {
            throw RecoveryStoreError.encodingFailed(
                snapshot.documentID,
                reason: error.localizedDescription
            )
        }

        let destinationURL = snapshotURL(for: snapshot.documentID)
        try writeAtomically(data, to: destinationURL)
    }

    func load(for documentID: DocumentID) throws -> RecoverySnapshot? {
        let url = snapshotURL(for: documentID)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }

        let snapshot = try decodeSnapshot(at: url)
        guard snapshot.documentID == documentID else {
            throw RecoveryStoreError.corruptSnapshot(
                url,
                reason: String(localized: "error.recovery.identifier-mismatch")
            )
        }
        return snapshot
    }

    func loadAll() throws -> [RecoverySnapshot] {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: baseURL.path, isDirectory: &isDirectory) else {
            return []
        }
        guard isDirectory.boolValue else {
            throw RecoveryStoreError.readFailed(
                baseURL,
                reason: String(localized: "error.recovery.path-not-directory")
            )
        }

        let urls: [URL]
        do {
            urls = try fileManager.contentsOfDirectory(
                at: baseURL,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            throw RecoveryStoreError.readFailed(baseURL, reason: error.localizedDescription)
        }

        return try urls
            .filter { $0.pathExtension.lowercased() == "json" }
            .map(decodeSnapshot(at:))
            .sorted {
                if $0.savedAt == $1.savedAt {
                    return $0.documentID.rawValue.uuidString < $1.documentID.rawValue.uuidString
                }
                return $0.savedAt > $1.savedAt
            }
    }

    func delete(for documentID: DocumentID) throws {
        let url = snapshotURL(for: documentID)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return
        }

        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            throw RecoveryStoreError.deletionFailed(url, reason: error.localizedDescription)
        }
    }

    private static func defaultBaseURL() -> URL {
        let fileManager = FileManager.default
        let applicationSupportURL = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)

        return applicationSupportURL
            .appendingPathComponent("Markedown", isDirectory: true)
            .appendingPathComponent("Recovery", isDirectory: true)
    }

    private func snapshotURL(for documentID: DocumentID) -> URL {
        baseURL.appendingPathComponent(
            "\(documentID.rawValue.uuidString.lowercased()).json",
            isDirectory: false
        )
    }

    private func ensureBaseDirectoryExists() throws {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: baseURL.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw RecoveryStoreError.directoryCreationFailed(
                    baseURL,
                    reason: "A file already exists at the recovery directory path."
                )
            }
            return
        }

        do {
            try fileManager.createDirectory(
                at: baseURL,
                withIntermediateDirectories: true
            )
        } catch {
            throw RecoveryStoreError.directoryCreationFailed(
                baseURL,
                reason: error.localizedDescription
            )
        }
    }

    private func decodeSnapshot(at url: URL) throws -> RecoverySnapshot {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw RecoveryStoreError.readFailed(url, reason: error.localizedDescription)
        }

        do {
            return try JSONDecoder().decode(RecoverySnapshot.self, from: data)
        } catch {
            throw RecoveryStoreError.corruptSnapshot(url, reason: error.localizedDescription)
        }
    }

    private func writeAtomically(_ data: Data, to url: URL) throws {
        let fileManager = FileManager.default
        let temporaryURL = baseURL.appendingPathComponent(
            ".\(url.lastPathComponent).markedown-recovery-\(UUID().uuidString).tmp"
        )

        defer {
            try? fileManager.removeItem(at: temporaryURL)
        }

        do {
            try data.write(to: temporaryURL, options: .withoutOverwriting)
            if fileManager.fileExists(atPath: url.path) {
                _ = try fileManager.replaceItemAt(url, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: url)
            }
        } catch {
            throw RecoveryStoreError.writeFailed(url, reason: error.localizedDescription)
        }
    }
}
