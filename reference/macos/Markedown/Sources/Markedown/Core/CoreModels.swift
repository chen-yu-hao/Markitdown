import Foundation
import Observation

struct DocumentID: Hashable, Codable, Sendable, Identifiable {
    let rawValue: UUID

    init(_ rawValue: UUID = UUID()) {
        self.rawValue = rawValue
    }

    var id: UUID { rawValue }
}

struct WorkspaceID: Hashable, Codable, Sendable, Identifiable {
    let rawValue: UUID

    init(_ rawValue: UUID = UUID()) {
        self.rawValue = rawValue
    }

    var id: UUID { rawValue }
}

struct DocumentRevision: Hashable, Codable, Sendable {
    let modificationDate: Date
    let fileSize: Int64
    let contentDigest: String
}

enum DocumentEncoding: String, Codable, CaseIterable, Sendable {
    case utf8
    case utf8WithBOM
}

enum LineEnding: String, Codable, CaseIterable, Sendable {
    case lf
    case crlf

    var sequence: String {
        switch self {
        case .lf: "\n"
        case .crlf: "\r\n"
        }
    }
}

enum EditorMode: String, Codable, CaseIterable, Sendable {
    case live
    case source
}

enum SidebarMode: String, Codable, CaseIterable, Sendable, Identifiable {
    case files
    case outline
    case search

    var id: String { rawValue }
}

enum EditorThemeID: String, Codable, CaseIterable, Sendable, Identifiable {
    case system
    case paper
    case graphite

    var id: String { rawValue }
}

struct ThemeDescriptor: Hashable, Codable, Sendable, Identifiable {
    let id: EditorThemeID
    let displayName: String
    let bodyFontName: String
    let codeFontName: String
    let readingWidth: Double
}

enum ExportFormat: String, Codable, CaseIterable, Sendable, Identifiable {
    case html
    case pdf
    case image
    case docx
    case epub
    case latex
    case rtf
    case odt

    var id: String { rawValue }
}

struct ExportOptions: Hashable, Codable, Sendable {
    var themeID: EditorThemeID = .system
    var pageSize: String = "A4"
    var includeOutline = true
    var includeStyles = true
    var allowsRemoteImages = false
}

struct OutlineItem: Hashable, Codable, Sendable, Identifiable {
    let id: UUID
    let title: String
    let level: Int
    let sourceRange: Range<String.Index>?

    init(
        id: UUID = UUID(),
        title: String,
        level: Int,
        sourceRange: Range<String.Index>? = nil
    ) {
        self.id = id
        self.title = title
        self.level = level
        self.sourceRange = sourceRange
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case level
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        level = try container.decode(Int.self, forKey: .level)
        sourceRange = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(level, forKey: .level)
    }
}

struct WorkspaceSearchResult: Hashable, Sendable, Identifiable {
    let id: UUID
    let fileURL: URL
    let line: Int
    let column: Int
    let preview: String

    init(
        id: UUID = UUID(),
        fileURL: URL,
        line: Int,
        column: Int,
        preview: String
    ) {
        self.id = id
        self.fileURL = fileURL
        self.line = line
        self.column = column
        self.preview = preview
    }
}

struct DocumentSnapshot: Sendable {
    let url: URL
    let source: String
    let encoding: DocumentEncoding
    let lineEnding: LineEnding
    let revision: DocumentRevision
}

@MainActor
@Observable
final class DocumentSession: Identifiable {
    let id: DocumentID
    var url: URL?
    var source: String
    var encoding: DocumentEncoding
    var lineEnding: LineEnding
    var revision: DocumentRevision?
    var isDirty: Bool
    var isSaving = false
    var editorMode: EditorMode
    @ObservationIgnored var scrollOffset: Double = 0
    @ObservationIgnored var selection: NSRange = NSRange(location: 0, length: 0)
    @ObservationIgnored var requiresExplicitSaveAfterRecovery: Bool
    var externalChangeDetected = false

    init(
        id: DocumentID = DocumentID(),
        url: URL? = nil,
        source: String = "",
        encoding: DocumentEncoding = .utf8,
        lineEnding: LineEnding = .lf,
        revision: DocumentRevision? = nil,
        isDirty: Bool = false,
        editorMode: EditorMode = .live,
        requiresExplicitSaveAfterRecovery: Bool = false
    ) {
        self.id = id
        self.url = url
        self.source = source
        self.encoding = encoding
        self.lineEnding = lineEnding
        self.revision = revision
        self.isDirty = isDirty
        self.editorMode = editorMode
        self.requiresExplicitSaveAfterRecovery = requiresExplicitSaveAfterRecovery
    }

    var displayName: String {
        url?.deletingPathExtension().lastPathComponent ?? String(localized: "Untitled")
    }

    var byteCount: Int {
        source.lengthOfBytes(using: .utf8)
    }

    var prefersSourceMode: Bool {
        byteCount > 1_048_576
    }

    var requiresSourceMode: Bool {
        byteCount > 5_242_880
    }

    func updateSource(_ newValue: String, markDirty: Bool = true) {
        source = newValue
        if markDirty {
            isDirty = true
        }
    }
}

@MainActor
@Observable
final class WorkspaceWindowSession: Identifiable {
    let id: WorkspaceID
    var rootURL: URL?
    var documents: [DocumentSession]
    var activeDocumentID: DocumentID?
    var sidebarMode: SidebarMode = .files
    var isSidebarVisible = true
    var isToolbarVisible = true
    var isFocusMode = false
    var isTypewriterMode = false
    var themeID: EditorThemeID = .system

    init(
        id: WorkspaceID = WorkspaceID(),
        rootURL: URL? = nil,
        documents: [DocumentSession] = []
    ) {
        self.id = id
        self.rootURL = rootURL
        self.documents = documents
        activeDocumentID = documents.first?.id
    }

    var activeDocument: DocumentSession? {
        guard let activeDocumentID else { return nil }
        return documents.first { $0.id == activeDocumentID }
    }

    func activate(_ document: DocumentSession) {
        if !documents.contains(where: { $0.id == document.id }) {
            documents.append(document)
        }
        activeDocumentID = document.id
    }

    func close(_ documentID: DocumentID) {
        guard let index = documents.firstIndex(where: { $0.id == documentID }) else { return }
        let wasActive = activeDocumentID == documentID
        documents.remove(at: index)
        if wasActive {
            activeDocumentID = documents.indices.contains(index)
                ? documents[index].id
                : documents.last?.id
        }
    }
}
