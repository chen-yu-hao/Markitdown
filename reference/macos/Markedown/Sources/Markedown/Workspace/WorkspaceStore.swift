import Foundation

enum WorkspaceNodeKind: String, Codable, Sendable {
    case directory
    case markdown
    case text
}

struct WorkspaceNode: Identifiable, Hashable, Codable, Sendable {
    let url: URL
    let name: String
    let kind: WorkspaceNodeKind
    let children: [WorkspaceNode]?

    var id: URL { url }
    var isDirectory: Bool { kind == .directory }
    var hasLoadedChildren: Bool { children != nil }

    init(
        url: URL,
        name: String? = nil,
        kind: WorkspaceNodeKind,
        children: [WorkspaceNode]? = nil
    ) {
        self.url = url
        self.name = name ?? url.lastPathComponent
        self.kind = kind
        self.children = children
    }
}

struct WorkspaceDescriptor: Identifiable, Hashable, Sendable {
    let id: WorkspaceID
    let rootURL: URL

    var displayName: String { rootURL.lastPathComponent }
}

enum WorkspaceStoreError: LocalizedError, Sendable {
    case notDirectory(URL)
    case packageDirectory(URL)
    case workspaceNotFound(WorkspaceID)
    case nodeIsNotDirectory(URL)
    case nodeOutsideWorkspace(URL)
    case unableToEnumerate(URL)

    var errorDescription: String? {
        switch self {
        case let .notDirectory(url):
            localizedFormat("error.workspace.not-directory", url.path)
        case let .packageDirectory(url):
            localizedFormat("error.workspace.package-directory", url.path)
        case .workspaceNotFound:
            String(localized: "error.workspace.not-open")
        case let .nodeIsNotDirectory(url):
            localizedFormat("error.workspace.item-not-directory", url.path)
        case let .nodeOutsideWorkspace(url):
            localizedFormat("error.workspace.item-outside", url.path)
        case let .unableToEnumerate(url):
            localizedFormat("error.workspace.enumerate-failed", url.path)
        }
    }
}

struct WorkspaceBookmarkResolution: Sendable {
    let url: URL
    let isStale: Bool
}

struct WorkspaceBookmarkClient: Sendable {
    let create: @Sendable (URL) throws -> Data
    let resolve: @Sendable (Data) throws -> WorkspaceBookmarkResolution

    static let securityScoped = WorkspaceBookmarkClient(
        create: { url in
            try url.bookmarkData(
                options: [.withSecurityScope],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
        },
        resolve: { data in
            var isStale = false
            let url = try URL(
                resolvingBookmarkData: data,
                options: [.withSecurityScope, .withoutUI],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            return WorkspaceBookmarkResolution(url: url, isStale: isStale)
        }
    )
}

actor WorkspaceStore {
    private struct PersistedBookmark: Codable, Sendable {
        let id: WorkspaceID
        var data: Data
        var lastOpenedAt: Date
    }

    private final class SecurityScopeLease: @unchecked Sendable {
        let url: URL
        private let shouldStopAccessing: Bool

        init(url: URL) {
            self.url = url
            shouldStopAccessing = url.startAccessingSecurityScopedResource()
        }

        deinit {
            if shouldStopAccessing {
                url.stopAccessingSecurityScopedResource()
            }
        }
    }

    private let userDefaults: UserDefaults
    private let bookmarkKey: String
    private let bookmarkClient: WorkspaceBookmarkClient
    private var workspaces: [WorkspaceID: WorkspaceDescriptor] = [:]
    private var securityScopeLeases: [WorkspaceID: SecurityScopeLease] = [:]

    init(
        userDefaultsSuiteName: String? = nil,
        bookmarkKey: String = "Markedown.workspaceBookmarks.v1",
        bookmarkClient: WorkspaceBookmarkClient = .securityScoped
    ) {
        userDefaults = userDefaultsSuiteName
            .flatMap(UserDefaults.init(suiteName:)) ?? .standard
        self.bookmarkKey = bookmarkKey
        self.bookmarkClient = bookmarkClient
    }

    func openWorkspace(at url: URL) throws -> WorkspaceDescriptor {
        let rootURL = url.standardizedFileURL
        if let existing = descriptor(forRootURL: rootURL) {
            return existing
        }

        let lease = SecurityScopeLease(url: rootURL)
        try validateWorkspaceRoot(rootURL)

        var bookmarks = try loadPersistedBookmarks()
        let existingBookmarkIndex = bookmarks.firstIndex { bookmark in
            guard let resolution = try? bookmarkClient.resolve(bookmark.data) else {
                return false
            }
            return Self.urlsReferToSameLocation(resolution.url, rootURL)
        }
        let id = existingBookmarkIndex.map { bookmarks[$0].id } ?? WorkspaceID()
        let bookmarkData = try bookmarkClient.create(rootURL)
        let bookmark = PersistedBookmark(id: id, data: bookmarkData, lastOpenedAt: Date())

        if let existingBookmarkIndex {
            bookmarks[existingBookmarkIndex] = bookmark
        } else {
            bookmarks.append(bookmark)
        }
        try savePersistedBookmarks(bookmarks)

        let descriptor = WorkspaceDescriptor(id: id, rootURL: rootURL)
        workspaces[id] = descriptor
        securityScopeLeases[id] = lease
        return descriptor
    }

    @discardableResult
    func restoreWorkspaces() throws -> [WorkspaceDescriptor] {
        var bookmarks = try loadPersistedBookmarks()
        var didRefreshBookmark = false
        var restored: [(descriptor: WorkspaceDescriptor, lastOpenedAt: Date)] = []

        for index in bookmarks.indices {
            let bookmark = bookmarks[index]
            if let existing = workspaces[bookmark.id] {
                restored.append((existing, bookmark.lastOpenedAt))
                continue
            }

            guard let resolution = try? bookmarkClient.resolve(bookmark.data) else {
                continue
            }
            let rootURL = resolution.url.standardizedFileURL
            let lease = SecurityScopeLease(url: rootURL)
            guard (try? validateWorkspaceRoot(rootURL)) != nil else {
                continue
            }

            if resolution.isStale,
               let refreshedData = try? bookmarkClient.create(rootURL) {
                bookmarks[index].data = refreshedData
                didRefreshBookmark = true
            }

            let descriptor = WorkspaceDescriptor(id: bookmark.id, rootURL: rootURL)
            workspaces[bookmark.id] = descriptor
            securityScopeLeases[bookmark.id] = lease
            restored.append((descriptor, bookmark.lastOpenedAt))
        }

        if didRefreshBookmark {
            try savePersistedBookmarks(bookmarks)
        }

        return restored
            .sorted { $0.lastOpenedAt > $1.lastOpenedAt }
            .map(\.descriptor)
    }

    func allWorkspaces() -> [WorkspaceDescriptor] {
        workspaces.values.sorted {
            $0.rootURL.path.localizedStandardCompare($1.rootURL.path) == .orderedAscending
        }
    }

    func closeWorkspace(_ id: WorkspaceID) {
        workspaces[id] = nil
        securityScopeLeases[id] = nil
    }

    func forgetWorkspace(_ id: WorkspaceID) throws {
        var bookmarks = try loadPersistedBookmarks()
        bookmarks.removeAll { $0.id == id }
        try savePersistedBookmarks(bookmarks)
        closeWorkspace(id)
    }

    func rootNode(for workspaceID: WorkspaceID) throws -> WorkspaceNode {
        guard let workspace = workspaces[workspaceID] else {
            throw WorkspaceStoreError.workspaceNotFound(workspaceID)
        }
        return WorkspaceNode(
            url: workspace.rootURL,
            name: workspace.displayName,
            kind: .directory
        )
    }

    func loadChildren(
        of node: WorkspaceNode,
        recursively: Bool = false
    ) async throws -> WorkspaceNode {
        guard node.isDirectory else {
            throw WorkspaceStoreError.nodeIsNotDirectory(node.url)
        }
        try ensureNodeIsInsideOpenWorkspace(node.url)
        let url = node.url

        return try await Task.detached(priority: .userInitiated) {
            try WorkspaceFilePolicy.directoryNode(
                at: url,
                recursively: recursively,
                loadChildren: true
            )
        }.value
    }

    func scanWorkspace(
        _ workspaceID: WorkspaceID,
        recursively: Bool = false
    ) async throws -> WorkspaceNode {
        let root = try rootNode(for: workspaceID)
        return try await loadChildren(of: root, recursively: recursively)
    }

    func scanRecursively(_ workspaceID: WorkspaceID) async throws -> WorkspaceNode {
        try await scanWorkspace(workspaceID, recursively: true)
    }

    func documentURLs(in workspaceID: WorkspaceID) async throws -> [URL] {
        guard let workspace = workspaces[workspaceID] else {
            throw WorkspaceStoreError.workspaceNotFound(workspaceID)
        }
        let rootURL = workspace.rootURL
        return try await Task.detached(priority: .utility) {
            try WorkspaceFilePolicy.recursiveDocumentURLs(at: rootURL)
        }.value
    }

    private func descriptor(forRootURL rootURL: URL) -> WorkspaceDescriptor? {
        workspaces.values.first {
            Self.urlsReferToSameLocation($0.rootURL, rootURL)
        }
    }

    private func validateWorkspaceRoot(_ url: URL) throws {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        guard values.isDirectory == true else {
            throw WorkspaceStoreError.notDirectory(url)
        }
        guard values.isPackage != true,
              !WorkspaceFilePolicy.hasKnownPackageExtension(url) else {
            throw WorkspaceStoreError.packageDirectory(url)
        }
    }

    private func ensureNodeIsInsideOpenWorkspace(_ url: URL) throws {
        guard workspaces.values.contains(where: {
            Self.url(url, isContainedIn: $0.rootURL)
        }) else {
            throw WorkspaceStoreError.nodeOutsideWorkspace(url)
        }
    }

    private func loadPersistedBookmarks() throws -> [PersistedBookmark] {
        guard let data = userDefaults.data(forKey: bookmarkKey) else {
            return []
        }
        return try JSONDecoder().decode([PersistedBookmark].self, from: data)
    }

    private func savePersistedBookmarks(_ bookmarks: [PersistedBookmark]) throws {
        let data = try JSONEncoder().encode(bookmarks)
        userDefaults.set(data, forKey: bookmarkKey)
    }

    private static func urlsReferToSameLocation(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.standardizedFileURL.resolvingSymlinksInPath()
            == rhs.standardizedFileURL.resolvingSymlinksInPath()
    }

    private static func url(_ candidate: URL, isContainedIn root: URL) -> Bool {
        let candidateComponents = candidate.standardizedFileURL
            .resolvingSymlinksInPath().pathComponents
        let rootComponents = root.standardizedFileURL
            .resolvingSymlinksInPath().pathComponents
        return candidateComponents.starts(with: rootComponents)
    }
}

enum WorkspaceFilePolicy {
    private static let markdownExtensions: Set<String> = [
        "md", "markdown", "mdown", "mkd", "mkdn", "mdtxt"
    ]
    private static let textExtensions: Set<String> = ["txt", "text"]
    private static let packageExtensions: Set<String> = [
        "app", "appex", "bundle", "framework", "key", "numbers", "pages",
        "photoslibrary", "playground", "plugin", "rtfd", "xcodeproj", "xcworkspace"
    ]
    private static let resourceKeys: Set<URLResourceKey> = [
        .isDirectoryKey,
        .isRegularFileKey,
        .isPackageKey,
        .isHiddenKey,
        .isSymbolicLinkKey
    ]

    static func directoryNode(
        at url: URL,
        recursively: Bool,
        loadChildren: Bool
    ) throws -> WorkspaceNode {
        try Task.checkCancellation()
        let children = loadChildren ? try childNodes(at: url, recursively: recursively) : nil
        return WorkspaceNode(
            url: url,
            name: url.lastPathComponent,
            kind: .directory,
            children: children
        )
    }

    static func recursiveDocumentURLs(at rootURL: URL) throws -> [URL] {
        let manager = FileManager()
        let rootValues = try rootURL.resourceValues(forKeys: [.isDirectoryKey])
        guard rootValues.isDirectory == true else {
            throw WorkspaceStoreError.notDirectory(rootURL)
        }
        guard let enumerator = manager.enumerator(
            at: rootURL,
            includingPropertiesForKeys: Array(resourceKeys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants],
            errorHandler: { _, _ in true }
        ) else {
            throw WorkspaceStoreError.unableToEnumerate(rootURL)
        }

        var urls: [URL] = []
        for case let url as URL in enumerator {
            try Task.checkCancellation()
            guard let values = try? url.resourceValues(forKeys: resourceKeys) else {
                continue
            }
            if shouldSkip(url: url, values: values) {
                if values.isDirectory == true {
                    enumerator.skipDescendants()
                }
                continue
            }
            if let kind = documentKind(for: url, values: values), kind != .directory {
                urls.append(url)
            }
        }

        return urls.sorted {
            $0.path.localizedStandardCompare($1.path) == .orderedAscending
        }
    }

    static func hasKnownPackageExtension(_ url: URL) -> Bool {
        packageExtensions.contains(url.pathExtension.lowercased())
    }

    private static func childNodes(at directoryURL: URL, recursively: Bool) throws -> [WorkspaceNode] {
        try Task.checkCancellation()
        let urls = try FileManager().contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: Array(resourceKeys),
            options: [.skipsHiddenFiles]
        )
        var nodes: [WorkspaceNode] = []

        for url in urls {
            try Task.checkCancellation()
            guard let values = try? url.resourceValues(forKeys: resourceKeys),
                  !shouldSkip(url: url, values: values),
                  let kind = documentKind(for: url, values: values) else {
                continue
            }

            if kind == .directory {
                let children = recursively ? try childNodes(at: url, recursively: true) : nil
                nodes.append(WorkspaceNode(url: url, kind: kind, children: children))
            } else {
                nodes.append(WorkspaceNode(url: url, kind: kind))
            }
        }

        return nodes.sorted(by: compareNodes)
    }

    private static func shouldSkip(url: URL, values: URLResourceValues) -> Bool {
        if values.isHidden == true || url.lastPathComponent.hasPrefix(".") {
            return true
        }
        if values.isSymbolicLink == true {
            return true
        }
        return values.isDirectory == true
            && (values.isPackage == true || hasKnownPackageExtension(url))
    }

    private static func documentKind(
        for url: URL,
        values: URLResourceValues
    ) -> WorkspaceNodeKind? {
        if values.isDirectory == true {
            return .directory
        }
        guard values.isRegularFile == true else {
            return nil
        }
        let fileExtension = url.pathExtension.lowercased()
        if markdownExtensions.contains(fileExtension) {
            return .markdown
        }
        if textExtensions.contains(fileExtension) {
            return .text
        }
        return nil
    }

    private static func compareNodes(_ lhs: WorkspaceNode, _ rhs: WorkspaceNode) -> Bool {
        if lhs.isDirectory != rhs.isDirectory {
            return lhs.isDirectory
        }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
}
