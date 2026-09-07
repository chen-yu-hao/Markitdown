import CryptoKit
import Foundation

enum DocumentStoreError: Error, Equatable, LocalizedError, Sendable {
    case fileNotFound(URL)
    case notRegularFile(URL)
    case unsupportedEncoding(URL)
    case readFailed(URL, reason: String)
    case metadataReadFailed(URL, reason: String)
    case destinationDirectoryMissing(URL)
    case revisionConflict(
        url: URL,
        expected: DocumentRevision?,
        actual: DocumentRevision?
    )
    case writeFailed(URL, reason: String)

    var errorDescription: String? {
        switch self {
        case .fileNotFound(let url):
            localizedFormat("error.document.file-not-found", url.path)
        case .notRegularFile(let url):
            localizedFormat("error.document.not-regular-file", url.path)
        case .unsupportedEncoding(let url):
            localizedFormat("error.document.invalid-utf8", url.path)
        case .readFailed(let url, let reason):
            localizedFormat("error.document.read-failed", url.path, reason)
        case .metadataReadFailed(let url, let reason):
            localizedFormat("error.document.metadata-failed", url.path, reason)
        case .destinationDirectoryMissing(let url):
            localizedFormat("error.document.destination-missing", url.path)
        case .revisionConflict(let url, _, _):
            localizedFormat("error.document.revision-conflict", url.path)
        case .writeFailed(let url, let reason):
            localizedFormat("error.document.write-failed", url.path, reason)
        }
    }
}

actor DocumentStore {
    func load(from url: URL) throws -> DocumentSnapshot {
        let fileURL = url.standardizedFileURL
        let data = try readData(from: fileURL)
        let decoded = try decode(data, from: fileURL)

        return DocumentSnapshot(
            url: fileURL,
            source: Self.normalizeLineEndings(in: decoded.source),
            encoding: decoded.encoding,
            lineEnding: Self.detectLineEnding(in: decoded.bodyData),
            revision: try makeRevision(for: data, at: fileURL)
        )
    }

    func revision(for url: URL) throws -> DocumentRevision? {
        let fileURL = url.standardizedFileURL
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }

        let data = try readData(from: fileURL)
        return try makeRevision(for: data, at: fileURL)
    }

    @discardableResult
    func save(
        source: String,
        to url: URL,
        encoding: DocumentEncoding,
        lineEnding: LineEnding,
        expectedRevision: DocumentRevision?
    ) throws -> DocumentSnapshot {
        let fileURL = url.standardizedFileURL
        let actualRevision = try revision(for: fileURL)

        if let expectedRevision {
            guard actualRevision == expectedRevision else {
                throw DocumentStoreError.revisionConflict(
                    url: fileURL,
                    expected: expectedRevision,
                    actual: actualRevision
                )
            }
        }

        let normalizedSource = Self.normalizeLineEndings(in: source)
        let serializedSource: String
        switch lineEnding {
        case .lf:
            serializedSource = normalizedSource
        case .crlf:
            serializedSource = normalizedSource.replacingOccurrences(of: "\n", with: "\r\n")
        }

        var data = Data()
        if encoding == .utf8WithBOM {
            data.append(contentsOf: Self.utf8BOM)
        }
        data.append(contentsOf: serializedSource.utf8)

        try writeAtomically(data, to: fileURL)
        return try load(from: fileURL)
    }

    private static let utf8BOM: [UInt8] = [0xEF, 0xBB, 0xBF]

    private func readData(from url: URL) throws -> Data {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: url.path) else {
            throw DocumentStoreError.fileNotFound(url)
        }

        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            guard values.isRegularFile == true else {
                throw DocumentStoreError.notRegularFile(url)
            }
        } catch let error as DocumentStoreError {
            throw error
        } catch {
            throw DocumentStoreError.metadataReadFailed(url, reason: error.localizedDescription)
        }

        do {
            return try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw DocumentStoreError.readFailed(url, reason: error.localizedDescription)
        }
    }

    private func decode(_ data: Data, from url: URL) throws -> (
        source: String,
        encoding: DocumentEncoding,
        bodyData: Data
    ) {
        let hasBOM = data.starts(with: Self.utf8BOM)
        let bodyData = hasBOM ? data.dropFirst(Self.utf8BOM.count) : data[...]

        guard let source = String(data: bodyData, encoding: .utf8) else {
            throw DocumentStoreError.unsupportedEncoding(url)
        }

        return (
            source,
            hasBOM ? .utf8WithBOM : .utf8,
            Data(bodyData)
        )
    }

    private func makeRevision(for data: Data, at url: URL) throws -> DocumentRevision {
        let modificationDate: Date
        do {
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey])
            guard let value = values.contentModificationDate else {
                throw DocumentStoreError.metadataReadFailed(
                    url,
                    reason: String(localized: "error.document.modification-date-unavailable")
                )
            }
            modificationDate = value
        } catch let error as DocumentStoreError {
            throw error
        } catch {
            throw DocumentStoreError.metadataReadFailed(url, reason: error.localizedDescription)
        }

        let digest = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()

        return DocumentRevision(
            modificationDate: modificationDate,
            fileSize: Int64(data.count),
            contentDigest: digest
        )
    }

    private func writeAtomically(_ data: Data, to url: URL) throws {
        let fileManager = FileManager.default
        let directoryURL = url.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw DocumentStoreError.destinationDirectoryMissing(directoryURL)
        }

        let temporaryURL = directoryURL.appendingPathComponent(
            ".\(url.lastPathComponent).markedown-save-\(UUID().uuidString).tmp"
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
            throw DocumentStoreError.writeFailed(url, reason: error.localizedDescription)
        }
    }

    private static func normalizeLineEndings(in source: String) -> String {
        source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    private static func detectLineEnding(in data: Data) -> LineEnding {
        var crlfCount = 0
        var lfCount = 0
        var firstLineEnding: LineEnding?
        var previousByte: UInt8?

        for byte in data {
            if byte == 0x0A {
                if previousByte == 0x0D {
                    crlfCount += 1
                    firstLineEnding = firstLineEnding ?? .crlf
                } else {
                    lfCount += 1
                    firstLineEnding = firstLineEnding ?? .lf
                }
            }
            previousByte = byte
        }

        if crlfCount == lfCount {
            return firstLineEnding ?? .lf
        }
        return crlfCount > lfCount ? .crlf : .lf
    }
}
