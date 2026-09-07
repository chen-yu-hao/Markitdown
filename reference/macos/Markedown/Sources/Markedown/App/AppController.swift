import AppKit
import Foundation
import Observation
import UniformTypeIdentifiers

struct AppNotice: Identifiable, Equatable {
    enum Kind: Equatable {
        case information
        case error
    }

    let id = UUID()
    let kind: Kind
    let title: String
    let message: String
}

struct DocumentConflict: Identifiable, Equatable {
    enum Reason: Equatable {
        case changed
        case deleted
    }

    let documentID: DocumentID
    let url: URL
    let expectedRevision: DocumentRevision?
    let actualRevision: DocumentRevision?
    let reason: Reason

    var id: DocumentID { documentID }

    var title: String {
        String(localized: "File Changed on Disk")
    }

    var message: String {
        switch reason {
        case .changed:
            String(localized: "This file was changed by another application. Reload it, save your work as a copy, or cancel to keep editing without overwriting the disk version.")
        case .deleted:
            String(localized: "This file was removed from disk. Save your work as a copy, or cancel to keep editing the recovered version.")
        }
    }
}

private struct IgnoredExternalRevision: Equatable {
    let revision: DocumentRevision?
}

@MainActor
@Observable
final class AppController {
    let settings: AppSettings
    let workspaceSession: WorkspaceWindowSession
    let commandCenter: EditorCommandCenter

    private let runtime: AppRuntime
    private let documentStore: DocumentStore
    private let recoveryStore: RecoveryStore
    private let workspaceStore: WorkspaceStore
    private let workspaceSearchService: WorkspaceSearchService
    private let markdownAnalyzer: MarkdownAnalyzer
    private let markdownExportService: MarkdownExportService
    private let isUITesting: Bool

    private(set) var workspaceID: WorkspaceID?
    private(set) var workspaceRootNode: WorkspaceNode?
    private(set) var analysisByDocument: [DocumentID: MarkdownAnalysis] = [:]
    private(set) var workspaceSearchResults: [WorkspaceSearchResult] = []
    private(set) var isSearchingWorkspace = false
    private(set) var isRestoringSession = false
    private(set) var isExporting = false
    private(set) var didStart = false

    var workspaceSearchQuery = ""
    var workspaceSearchIsCaseSensitive = false
    var isFindBarVisible = false
    var findQuery = ""
    var replacementText = ""
    var findResult = EditorFindResult(current: 0, total: 0)
    var notice: AppNotice?
    var pendingConflict: DocumentConflict?

    private var documentLeases: [DocumentID: SecurityScopedURLLease] = [:]
    private var recoveryTasks: [DocumentID: Task<Void, Never>] = [:]
    private var autoSaveTasks: [DocumentID: Task<Void, Never>] = [:]
    private var analysisTasks: [DocumentID: Task<Void, Never>] = [:]
    private var ignoredExternalRevisions: [DocumentID: IgnoredExternalRevision] = [:]
    private var searchTask: Task<Void, Never>?
    private var externalChangeMonitor: Task<Void, Never>?

    init(
        settings: AppSettings = AppSettings(),
        workspaceSession: WorkspaceWindowSession = WorkspaceWindowSession(),
        commandCenter: EditorCommandCenter = EditorCommandCenter(),
        runtime: AppRuntime = AppRuntime(),
        documentStore: DocumentStore = DocumentStore(),
        recoveryStore: RecoveryStore = RecoveryStore(),
        workspaceStore: WorkspaceStore = WorkspaceStore(),
        workspaceSearchService: WorkspaceSearchService = WorkspaceSearchService(),
        markdownAnalyzer: MarkdownAnalyzer = MarkdownAnalyzer(),
        markdownExportService: MarkdownExportService = MarkdownExportService()
    ) {
        self.settings = settings
        self.workspaceSession = workspaceSession
        self.commandCenter = commandCenter
        self.runtime = runtime
        self.documentStore = documentStore
        self.recoveryStore = recoveryStore
        self.workspaceStore = workspaceStore
        self.workspaceSearchService = workspaceSearchService
        self.markdownAnalyzer = markdownAnalyzer
        self.markdownExportService = markdownExportService
        isUITesting = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        workspaceSession.themeID = settings.themeID
        workspaceSession.isToolbarVisible = settings.showToolbar
    }

    var activeDocument: DocumentSession? {
        workspaceSession.activeDocument
    }

    var activeAnalysis: MarkdownAnalysis? {
        guard let id = workspaceSession.activeDocumentID else { return nil }
        return analysisByDocument[id]
    }

    var outline: [OutlineItem] {
        activeAnalysis?.outline ?? []
    }

    var statistics: MarkdownStatistics? {
        activeAnalysis?.statistics
    }

    var canSave: Bool {
        activeDocument?.isDirty == true && activeDocument?.isSaving == false
    }

    func start() async {
        guard !didStart else { return }
        didStart = true
        isRestoringSession = true
        defer { isRestoringSession = false }

        if isUITesting {
            newDocument()
            return
        }

        let shouldRestoreStartupState = runtime.claimStartupRestoration()
        if shouldRestoreStartupState, settings.rememberWorkspace {
            do {
                if let restored = try await workspaceStore.restoreWorkspaces().first {
                    workspaceID = restored.id
                    workspaceSession.rootURL = restored.rootURL
                    workspaceRootNode = try await workspaceStore.scanWorkspace(
                        restored.id,
                        recursively: false
                    )
                }
            } catch {
                present(error, title: String(localized: "Workspace Could Not Be Restored"))
            }
        }

        if shouldRestoreStartupState {
            do {
                let recoveries = try await recoveryStore.loadAll()
                for recovery in recoveries {
                    restore(recovery)
                }
            } catch {
                present(error, title: String(localized: "Recovery Data Could Not Be Loaded"))
            }
        }

        if workspaceSession.documents.isEmpty {
            newDocument()
        }
        startExternalChangeMonitor()
    }

    func newDocument() {
        let document = DocumentSession()
        workspaceSession.activate(document)
        analyze(document)
    }

    func chooseFilesToOpen() {
        let panel = NSOpenPanel()
        panel.title = String(localized: "Open Markdown Document")
        panel.allowedContentTypes = Self.markdownContentTypes
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true

        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        Task { await openFiles(urls) }
    }

    func chooseFolderToOpen() {
        let panel = NSOpenPanel()
        panel.title = String(localized: "Open Folder")
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await openWorkspace(at: url) }
    }

    func openURL(_ url: URL) {
        Task {
            do {
                let values = try url.resourceValues(forKeys: [.isDirectoryKey])
                if values.isDirectory == true {
                    await openWorkspace(at: url)
                } else {
                    await openFile(at: url)
                }
            } catch {
                present(error, title: String(localized: "Item Could Not Be Opened"))
            }
        }
    }

    func openFiles(_ urls: [URL]) async {
        for url in urls {
            await openFile(at: url)
        }
    }

    func presentImageImportRequiresSave() {
        notice = AppNotice(
            kind: .information,
            title: String(localized: "Save Before Adding Images"),
            message: String(localized: "Save this document, then add the images again so Markedown can create its assets folder.")
        )
    }

    @discardableResult
    func openDroppedFiles(_ urls: [URL]) -> Bool {
        let acceptedURLs = Self.supportedDroppedDocumentURLs(from: urls)
        guard !acceptedURLs.isEmpty else { return false }

        Task { await openFiles(acceptedURLs) }
        return true
    }

    static func supportedDroppedDocumentURLs(
        from urls: [URL],
        fileManager: FileManager = .default
    ) -> [URL] {
        var seenURLs = Set<URL>()
        var acceptedURLs: [URL] = []

        for url in urls where url.isFileURL {
            let standardizedURL = url.standardizedFileURL
            guard supportedDocumentExtensions.contains(
                standardizedURL.pathExtension.lowercased()
            ) else {
                continue
            }

            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(
                atPath: standardizedURL.path,
                isDirectory: &isDirectory
            ), !isDirectory.boolValue,
            seenURLs.insert(standardizedURL).inserted else {
                continue
            }
            acceptedURLs.append(standardizedURL)
        }
        return acceptedURLs
    }

    func openFile(at url: URL) async {
        let standardizedURL = url.standardizedFileURL
        if let existing = document(for: standardizedURL) {
            activateDocument(existing.id)
            return
        }

        let documentID = DocumentID()
        guard runtime.claimDocument(
            at: standardizedURL,
            documentID: documentID,
            owner: self
        ) else {
            notice = AppNotice(
                kind: .information,
                title: String(localized: "Document Already Open"),
                message: String(localized: "This document is already open for editing in another window.")
            )
            return
        }

        let lease = SecurityScopedURLLease(url: standardizedURL)
        do {
            let snapshot = try await documentStore.load(from: standardizedURL)
            let mode: EditorMode = snapshot.source.lengthOfBytes(using: .utf8) > 5_242_880
                ? .source
                : .live
            let document = DocumentSession(
                id: documentID,
                url: snapshot.url,
                source: snapshot.source,
                encoding: snapshot.encoding,
                lineEnding: snapshot.lineEnding,
                revision: snapshot.revision,
                isDirty: false,
                editorMode: mode
            )
            discardEmptyUntitledIfNeeded()
            documentLeases[document.id] = lease
            workspaceSession.activate(document)
            analyze(document)
        } catch {
            runtime.releaseDocument(
                at: standardizedURL,
                documentID: documentID,
                owner: self
            )
            present(error, title: String(localized: "Document Could Not Be Opened"))
        }
    }

    func openWorkspace(at url: URL) async {
        do {
            let descriptor = try await workspaceStore.openWorkspace(at: url)
            workspaceID = descriptor.id
            workspaceSession.rootURL = descriptor.rootURL
            workspaceRootNode = try await workspaceStore.scanWorkspace(
                descriptor.id,
                recursively: false
            )
            workspaceSession.sidebarMode = .files
            workspaceSession.isSidebarVisible = true
            workspaceSearchResults = []
            workspaceSearchQuery = ""
        } catch {
            present(error, title: String(localized: "Folder Could Not Be Opened"))
        }
    }

    func refreshWorkspace(recursively: Bool = false) async {
        guard let workspaceID else { return }
        do {
            workspaceRootNode = try await workspaceStore.scanWorkspace(
                workspaceID,
                recursively: recursively
            )
        } catch {
            present(error, title: String(localized: "Folder Could Not Be Refreshed"))
        }
    }

    func loadWorkspaceChildren(of node: WorkspaceNode) async {
        guard node.isDirectory else { return }
        do {
            let loaded = try await workspaceStore.loadChildren(of: node, recursively: false)
            guard let root = workspaceRootNode else { return }
            workspaceRootNode = Self.replacing(nodeAt: loaded.url, with: loaded, in: root)
        } catch {
            present(error, title: String(localized: "Folder Could Not Be Read"))
        }
    }

    func activateDocument(_ id: DocumentID) {
        guard let document = workspaceSession.documents.first(where: { $0.id == id }) else {
            return
        }
        workspaceSession.activate(document)
        if analysisByDocument[id] == nil {
            analyze(document)
        }
        Task { await refreshExternalRevision(for: document) }
    }

    @discardableResult
    func closeDocument(_ id: DocumentID, force: Bool = false) async -> Bool {
        guard let document = workspaceSession.documents.first(where: { $0.id == id }) else {
            return true
        }

        if document.isDirty, !force {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = String(localized: "Save Changes?")
            alert.informativeText = localizedFormat(
                "save-changes-message",
                document.displayName
            )
            alert.addButton(withTitle: String(localized: "Save"))
            alert.addButton(withTitle: String(localized: "Cancel"))
            alert.addButton(withTitle: String(localized: "Don't Save"))

            switch alert.runModal() {
            case .alertFirstButtonReturn:
                guard await save(document) else { return false }
            case .alertThirdButtonReturn:
                break
            default:
                return false
            }
        }

        recoveryTasks[id]?.cancel()
        recoveryTasks[id] = nil
        autoSaveTasks[id]?.cancel()
        autoSaveTasks[id] = nil
        analysisTasks[id]?.cancel()
        analysisTasks[id] = nil
        analysisByDocument[id] = nil
        ignoredExternalRevisions[id] = nil
        documentLeases[id] = nil
        commandCenter.unregister(documentID: id)
        if let url = document.url {
            runtime.releaseDocument(at: url, documentID: id, owner: self)
        }
        runtime.releaseRecovery(id, owner: self)
        workspaceSession.close(id)
        try? await recoveryStore.delete(for: id)

        if workspaceSession.documents.isEmpty {
            newDocument()
        }
        return true
    }

    func closeActiveDocument() {
        guard let id = workspaceSession.activeDocumentID else { return }
        Task { _ = await closeDocument(id) }
    }

    func updateSource(_ source: String, for documentID: DocumentID) {
        guard let document = workspaceSession.documents.first(where: { $0.id == documentID }),
              document.source != source else {
            return
        }
        document.updateSource(source)
        analyze(document)
        schedulePersistence(for: document)
    }

    func updateSelection(_ range: NSRange, scrollOffset: Double, for documentID: DocumentID) {
        guard let document = workspaceSession.documents.first(where: { $0.id == documentID }) else {
            return
        }
        let selectionChanged = !NSEqualRanges(document.selection, range)
        let scrollChanged = abs(document.scrollOffset - scrollOffset) > 0.5
        guard selectionChanged || scrollChanged else { return }
        document.selection = range
        document.scrollOffset = scrollOffset
        if document.isDirty {
            scheduleRecovery(for: document, delay: .milliseconds(250))
        }
    }

    @discardableResult
    func saveActiveDocument() async -> Bool {
        guard let document = activeDocument else { return false }
        return await save(document)
    }

    func saveActiveDocumentFromMenu() {
        Task { _ = await saveActiveDocument() }
    }

    @discardableResult
    func save(_ document: DocumentSession) async -> Bool {
        guard document.url != nil else {
            return await saveAs(document)
        }
        guard let url = document.url else { return false }
        return await save(document, to: url, expectedRevision: document.revision, updateLocation: false)
    }

    @discardableResult
    func saveAs(_ document: DocumentSession? = nil) async -> Bool {
        guard let document = document ?? activeDocument else { return false }
        let panel = NSSavePanel()
        panel.title = String(localized: "Save Markdown Document")
        panel.allowedContentTypes = [Self.markdownContentType]
        panel.nameFieldStringValue = document.url?.lastPathComponent
            ?? String(localized: "Untitled.md")
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let url = panel.url else { return false }
        return await save(document, to: url, expectedRevision: nil, updateLocation: true)
    }

    func saveActiveDocumentAs() {
        Task { _ = await saveAs() }
    }

    func reloadConflictDocument() {
        guard let conflict = pendingConflict,
              let document = workspaceSession.documents.first(where: {
                  $0.id == conflict.documentID
              }) else {
            pendingConflict = nil
            return
        }

        Task {
            do {
                let snapshot = try await documentStore.load(from: conflict.url)
                document.url = snapshot.url
                document.source = snapshot.source
                document.encoding = snapshot.encoding
                document.lineEnding = snapshot.lineEnding
                document.revision = snapshot.revision
                document.isDirty = false
                document.externalChangeDetected = false
                document.requiresExplicitSaveAfterRecovery = false
                ignoredExternalRevisions[document.id] = nil
                pendingConflict = nil
                try? await recoveryStore.delete(for: document.id)
                analyze(document)
            } catch {
                present(error, title: String(localized: "Document Could Not Be Reloaded"))
            }
        }
    }

    func saveConflictCopy() {
        guard let conflict = pendingConflict,
              let document = workspaceSession.documents.first(where: {
                  $0.id == conflict.documentID
              }) else {
            pendingConflict = nil
            return
        }

        Task {
            if await saveAs(document) {
                document.externalChangeDetected = false
                ignoredExternalRevisions[document.id] = nil
                pendingConflict = nil
            }
        }
    }

    func cancelConflict() {
        if let pendingConflict {
            ignoredExternalRevisions[pendingConflict.documentID] = IgnoredExternalRevision(
                revision: pendingConflict.actualRevision
            )
        }
        pendingConflict = nil
    }

    func performWorkspaceSearch() {
        searchWorkspace(workspaceSearchQuery)
    }

    func searchWorkspace(_ query: String) {
        workspaceSearchQuery = query
        searchTask?.cancel()

        guard let rootURL = workspaceSession.rootURL, !query.isEmpty else {
            workspaceSearchResults = []
            isSearchingWorkspace = false
            Task { await workspaceSearchService.cancelCurrentSearch() }
            return
        }

        isSearchingWorkspace = true
        let options = WorkspaceSearchOptions(
            caseSensitive: workspaceSearchIsCaseSensitive,
            maximumResults: 500
        )
        searchTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let results = try await self.workspaceSearchService.search(
                    for: query,
                    in: rootURL,
                    options: options
                )
                try Task.checkCancellation()
                self.workspaceSearchResults = results
            } catch is CancellationError {
                return
            } catch {
                self.present(error, title: String(localized: "Search Failed"))
            }
            self.isSearchingWorkspace = false
        }
    }

    func cancelWorkspaceSearch() {
        searchTask?.cancel()
        searchTask = nil
        isSearchingWorkspace = false
        Task { await workspaceSearchService.cancelCurrentSearch() }
    }

    func showFind() {
        isFindBarVisible = true
        commandCenter.perform(.focus)
    }

    func closeFind() {
        isFindBarVisible = false
        findResult = EditorFindResult(current: 0, total: 0)
        commandCenter.activeAdapter?.find("", options: EditorFindOptions())
    }

    func findInDocument() {
        commandCenter.activeAdapter?.find(findQuery, options: EditorFindOptions())
    }

    func replaceCurrentFindResult() {
        commandCenter.activeAdapter?.replaceCurrent(with: replacementText)
    }

    func replaceAllFindResults() {
        commandCenter.activeAdapter?.replaceAll(
            query: findQuery,
            replacement: replacementText,
            options: EditorFindOptions()
        )
    }

    func setEditorMode(_ mode: EditorMode) {
        guard let document = activeDocument else { return }
        document.editorMode = mode
        commandCenter.activeAdapter?.setMode(mode)
        scheduleRecovery(for: document, delay: .milliseconds(100))
    }

    func toggleSidebar() {
        workspaceSession.isSidebarVisible.toggle()
    }

    func toggleFocusMode() {
        workspaceSession.isFocusMode.toggle()
    }

    func toggleTypewriterMode() {
        workspaceSession.isTypewriterMode.toggle()
    }

    func toggleFormattingToolbar() {
        workspaceSession.isToolbarVisible.toggle()
    }

    func exportHTML() {
        guard let document = activeDocument else { return }
        let panel = NSSavePanel()
        panel.title = String(localized: "Export HTML")
        panel.allowedContentTypes = [.html]
        panel.nameFieldStringValue = exportStem(for: document) + ".html"
        guard panel.runModal() == .OK, let outputURL = panel.url else { return }

        let source = document.source
        let title = document.displayName
        let options = currentExportOptions
        isExporting = true

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let service = self.markdownExportService
                let data = await Task.detached(priority: .userInitiated) {
                    service.makeHTMLData(markdown: source, title: title, options: options)
                }.value
                try await Task.detached(priority: .utility) {
                    try data.write(to: outputURL, options: .atomic)
                }.value
                self.notice = AppNotice(
                    kind: .information,
                    title: String(localized: "Export Complete"),
                    message: outputURL.path
                )
            } catch {
                self.present(error, title: String(localized: "HTML Export Failed"))
            }
            self.isExporting = false
        }
    }

    func exportRendered(_ format: ExportFormat) {
        guard format == .pdf || format == .image,
              let document = activeDocument else {
            return
        }

        let panel = NSSavePanel()
        panel.title = format == .pdf
            ? String(localized: "Export PDF")
            : String(localized: "Export Long Image")
        panel.allowedContentTypes = format == .pdf ? [.pdf] : [.png]
        panel.nameFieldStringValue = exportStem(for: document) + "." + format.fileExtension
        guard panel.runModal() == .OK, let outputURL = panel.url else { return }

        let source = document.source
        let title = document.displayName
        let options = currentExportOptions
        let service = markdownExportService
        isExporting = true

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.isExporting = false }

            do {
                let request = try await Task.detached(priority: .userInitiated) {
                    try service.makeRenderRequest(
                        markdown: source,
                        title: title,
                        format: format,
                        options: options
                    )
                }.value
                try await WebKitRenderExporter().export(request, to: outputURL)
                self.notice = AppNotice(
                    kind: .information,
                    title: String(localized: "Export Complete"),
                    message: outputURL.path
                )
            } catch {
                self.present(error, title: String(localized: "Rendered Export Failed"))
            }
        }
    }

    func exportWithPandoc(_ format: ExportFormat) {
        guard let document = activeDocument else { return }
        guard let executableURL = Self.detectPandocExecutable() else {
            notice = AppNotice(
                kind: .error,
                title: String(localized: "Pandoc Not Found"),
                message: String(localized: "Install Pandoc in /opt/homebrew/bin or /usr/local/bin to export this format.")
            )
            return
        }

        let panel = NSSavePanel()
        panel.title = localizedFormat("export-format-title", format.rawValue.uppercased())
        panel.nameFieldStringValue = exportStem(for: document) + "." + format.fileExtension
        guard panel.runModal() == .OK, let outputURL = panel.url else { return }

        let source = document.source
        let options = currentExportOptions
        isExporting = true

        Task { @MainActor [weak self] in
            guard let self else { return }
            let inputURL = FileManager.default.temporaryDirectory.appendingPathComponent(
                "markedown-export-\(UUID().uuidString).md"
            )
            do {
                let sourceData = Data(source.utf8)
                try await Task.detached(priority: .utility) {
                    try sourceData.write(to: inputURL, options: .atomic)
                }.value
                let adapter = PandocCommandAdapter(executableURL: executableURL)
                let command = try adapter.command(
                    inputURL: inputURL,
                    outputURL: outputURL,
                    format: format,
                    options: options
                )
                _ = try await Task.detached(priority: .userInitiated) {
                    try adapter.run(command)
                }.value
                self.notice = AppNotice(
                    kind: .information,
                    title: String(localized: "Export Complete"),
                    message: outputURL.path
                )
            } catch {
                self.present(error, title: String(localized: "Pandoc Export Failed"))
            }
            try? FileManager.default.removeItem(at: inputURL)
            self.isExporting = false
        }
    }

    func dismissNotice() {
        notice = nil
    }

    private func restore(_ recovery: RecoverySnapshot) {
        guard runtime.claimRecovery(recovery.documentID, owner: self) else { return }

        if let url = recovery.url, let existing = document(for: url) {
            existing.source = recovery.source
            existing.encoding = recovery.encoding
            existing.lineEnding = recovery.lineEnding
            existing.revision = recovery.revision
            existing.editorMode = recovery.editorMode
            existing.selection = NSRange(
                location: recovery.selectionLocation,
                length: recovery.selectionLength
            )
            existing.scrollOffset = recovery.scrollOffset
            existing.isDirty = true
            existing.requiresExplicitSaveAfterRecovery = true
            workspaceSession.activate(existing)
            analyze(existing)
            return
        }

        var restoredURL = recovery.url
        var restoredRevision = recovery.revision
        if let url = restoredURL,
           !runtime.claimDocument(
               at: url,
               documentID: recovery.documentID,
               owner: self
           ) {
            restoredURL = nil
            restoredRevision = nil
        }

        let document = DocumentSession(
            id: recovery.documentID,
            url: restoredURL,
            source: recovery.source,
            encoding: recovery.encoding,
            lineEnding: recovery.lineEnding,
            revision: restoredRevision,
            isDirty: true,
            editorMode: recovery.editorMode,
            requiresExplicitSaveAfterRecovery: true
        )
        document.selection = NSRange(
            location: recovery.selectionLocation,
            length: recovery.selectionLength
        )
        document.scrollOffset = recovery.scrollOffset
        if let url = restoredURL {
            documentLeases[document.id] = SecurityScopedURLLease(url: url)
        }
        workspaceSession.activate(document)
        analyze(document)
    }

    @discardableResult
    private func save(
        _ document: DocumentSession,
        to url: URL,
        expectedRevision: DocumentRevision?,
        updateLocation: Bool
    ) async -> Bool {
        guard !document.isSaving else { return false }
        document.isSaving = true
        defer { document.isSaving = false }

        let source = document.source
        let normalizedURL = url.standardizedFileURL
        let previousURL = document.url
        let locationChanged = updateLocation
            && previousURL?.standardizedFileURL.resolvingSymlinksInPath()
                != normalizedURL.resolvingSymlinksInPath()
        if locationChanged,
           !runtime.claimDocument(
               at: normalizedURL,
               documentID: document.id,
               owner: self
           ) {
            notice = AppNotice(
                kind: .information,
                title: String(localized: "Document Already Open"),
                message: String(localized: "This document is already open for editing in another window.")
            )
            return false
        }
        var shouldReleaseNewClaim = locationChanged
        defer {
            if shouldReleaseNewClaim {
                runtime.releaseDocument(
                    at: normalizedURL,
                    documentID: document.id,
                    owner: self
                )
            }
        }

        do {
            let saved = try await documentStore.save(
                source: source,
                to: normalizedURL,
                encoding: document.encoding,
                lineEnding: document.lineEnding,
                expectedRevision: expectedRevision
            )

            if updateLocation {
                if let previousURL, locationChanged {
                    runtime.releaseDocument(
                        at: previousURL,
                        documentID: document.id,
                        owner: self
                    )
                }
                documentLeases[document.id] = SecurityScopedURLLease(url: normalizedURL)
                document.url = saved.url
                shouldReleaseNewClaim = false
            }
            document.revision = saved.revision
            document.externalChangeDetected = false
            document.requiresExplicitSaveAfterRecovery = false
            ignoredExternalRevisions[document.id] = nil
            if document.source == source {
                document.isDirty = false
                try? await recoveryStore.delete(for: document.id)
            } else {
                document.isDirty = true
                schedulePersistence(for: document)
            }
            return true
        } catch let error as DocumentStoreError {
            if case .revisionConflict(
                let conflictURL,
                let expected,
                let actual
            ) = error {
                document.externalChangeDetected = true
                ignoredExternalRevisions[document.id] = nil
                pendingConflict = DocumentConflict(
                    documentID: document.id,
                    url: conflictURL,
                    expectedRevision: expected,
                    actualRevision: actual,
                    reason: actual == nil ? .deleted : .changed
                )
            } else {
                present(error, title: String(localized: "Document Could Not Be Saved"))
            }
            return false
        } catch {
            present(error, title: String(localized: "Document Could Not Be Saved"))
            return false
        }
    }

    private func schedulePersistence(for document: DocumentSession) {
        guard !isUITesting else { return }
        scheduleRecovery(for: document, delay: .milliseconds(220))
        guard settings.autoSave,
              document.url != nil,
              !document.requiresExplicitSaveAfterRecovery else {
            return
        }

        let documentID = document.id
        autoSaveTasks[documentID]?.cancel()
        autoSaveTasks[documentID] = Task { @MainActor [weak self, weak document] in
            do {
                try await Task.sleep(for: .seconds(1.1))
                try Task.checkCancellation()
            } catch {
                return
            }
            guard let self, let document, document.isDirty else { return }
            _ = await self.save(document)
            self.autoSaveTasks[documentID] = nil
        }
    }

    private func scheduleRecovery(for document: DocumentSession, delay: Duration) {
        let documentID = document.id
        recoveryTasks[documentID]?.cancel()
        recoveryTasks[documentID] = Task { @MainActor [weak self, weak document] in
            do {
                try await Task.sleep(for: delay)
                try Task.checkCancellation()
            } catch {
                return
            }
            guard let self, let document, document.isDirty else { return }
            let snapshot = Self.recoverySnapshot(for: document)
            do {
                try await self.recoveryStore.save(snapshot)
            } catch {
                self.present(error, title: String(localized: "Recovery Snapshot Could Not Be Saved"))
            }
            self.recoveryTasks[documentID] = nil
        }
    }

    private func analyze(_ document: DocumentSession) {
        let documentID = document.id
        let source = document.source
        let analyzer = markdownAnalyzer
        analysisTasks[documentID]?.cancel()
        analysisTasks[documentID] = Task { @MainActor [weak self, weak document] in
            let analysis = await Task.detached(priority: .utility) {
                analyzer.analyze(source)
            }.value
            guard !Task.isCancelled, let self, let document, document.source == source else {
                return
            }
            self.analysisByDocument[documentID] = analysis
            self.analysisTasks[documentID] = nil
        }
    }

    private func startExternalChangeMonitor() {
        externalChangeMonitor?.cancel()
        externalChangeMonitor = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
                guard let self else { return }
                for document in self.workspaceSession.documents where document.url != nil {
                    await self.refreshExternalRevision(for: document)
                }
            }
        }
    }

    private func refreshExternalRevision(for document: DocumentSession) async {
        guard !document.isSaving, let url = document.url, let expected = document.revision else {
            return
        }

        do {
            let actual = try await documentStore.revision(for: url)
            guard document.revision == expected, actual != expected else { return }

            if !document.isDirty, actual != nil {
                let snapshot = try await documentStore.load(from: url)
                guard document.revision == expected, !document.isDirty else { return }
                document.source = snapshot.source
                document.encoding = snapshot.encoding
                document.lineEnding = snapshot.lineEnding
                document.revision = snapshot.revision
                document.externalChangeDetected = false
                analyze(document)
                return
            }

            document.externalChangeDetected = true
            let ignored = ignoredExternalRevisions[document.id]
            if (ignored == nil || ignored?.revision != actual),
               pendingConflict?.documentID != document.id {
                pendingConflict = DocumentConflict(
                    documentID: document.id,
                    url: url,
                    expectedRevision: expected,
                    actualRevision: actual,
                    reason: actual == nil ? .deleted : .changed
                )
            }
        } catch {
            guard !document.externalChangeDetected else { return }
            document.externalChangeDetected = true
            present(error, title: String(localized: "External Change Check Failed"))
        }
    }

    private func document(for url: URL) -> DocumentSession? {
        let normalized = url.standardizedFileURL.resolvingSymlinksInPath()
        return workspaceSession.documents.first { document in
            document.url?.standardizedFileURL.resolvingSymlinksInPath() == normalized
        }
    }

    private func discardEmptyUntitledIfNeeded() {
        guard workspaceSession.documents.count == 1,
              let document = workspaceSession.documents.first,
              document.url == nil,
              document.source.isEmpty,
              !document.isDirty else {
            return
        }
        analysisTasks[document.id]?.cancel()
        analysisTasks[document.id] = nil
        analysisByDocument[document.id] = nil
        workspaceSession.close(document.id)
    }

    private func present(_ error: any Error, title: String) {
        notice = AppNotice(
            kind: .error,
            title: title,
            message: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        )
    }

    private var currentExportOptions: ExportOptions {
        ExportOptions(
            themeID: workspaceSession.themeID,
            pageSize: settings.exportPageSize,
            includeOutline: settings.exportIncludesOutline,
            includeStyles: true,
            allowsRemoteImages: settings.loadRemoteImages
        )
    }

    private func exportStem(for document: DocumentSession) -> String {
        document.displayName
    }

    private static func recoverySnapshot(for document: DocumentSession) -> RecoverySnapshot {
        RecoverySnapshot(
            documentID: document.id,
            url: document.url,
            source: document.source,
            encoding: document.encoding,
            lineEnding: document.lineEnding,
            revision: document.revision,
            editorMode: document.editorMode,
            selectionLocation: document.selection.location,
            selectionLength: document.selection.length,
            scrollOffset: document.scrollOffset
        )
    }

    private static func replacing(
        nodeAt url: URL,
        with replacement: WorkspaceNode,
        in node: WorkspaceNode
    ) -> WorkspaceNode {
        if node.url.standardizedFileURL == url.standardizedFileURL {
            return replacement
        }
        guard let children = node.children else { return node }
        return WorkspaceNode(
            url: node.url,
            name: node.name,
            kind: node.kind,
            children: children.map { replacing(nodeAt: url, with: replacement, in: $0) }
        )
    }

    private static let markdownContentTypes: [UTType] = {
        var types: [UTType] = [markdownContentType, .plainText]
        return Array(Set(types))
    }()

    private static let markdownContentType = UTType(
        importedAs: "net.daringfireball.markdown",
        conformingTo: .plainText
    )

    private static let supportedDocumentExtensions: Set<String> = [
        "md", "markdown", "mdown", "mkd", "txt",
    ]

    private static func detectPandocExecutable() -> URL? {
        [
            "/opt/homebrew/bin/pandoc",
            "/usr/local/bin/pandoc",
            "/usr/bin/pandoc",
        ]
        .first(where: FileManager.default.isExecutableFile(atPath:))
        .map(URL.init(fileURLWithPath:))
    }
}

private final class SecurityScopedURLLease {
    let url: URL
    private let isAccessing: Bool

    init(url: URL) {
        self.url = url
        isAccessing = url.startAccessingSecurityScopedResource()
    }

    deinit {
        if isAccessing {
            url.stopAccessingSecurityScopedResource()
        }
    }
}

extension ExportFormat {
    fileprivate var fileExtension: String {
        switch self {
        case .html: "html"
        case .pdf: "pdf"
        case .image: "png"
        case .docx: "docx"
        case .epub: "epub"
        case .latex: "tex"
        case .rtf: "rtf"
        case .odt: "odt"
        }
    }
}
