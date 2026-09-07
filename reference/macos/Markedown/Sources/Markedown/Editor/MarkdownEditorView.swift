import AppKit
import MarkdownEngine
import SwiftUI

@MainActor
struct MarkdownEditorView: View {
    @Bindable var document: DocumentSession

    let settings: AppSettings
    let commandCenter: EditorCommandCenter
    let isActive: Bool
    let typewriterMode: Bool
    let onSourceChange: (String) -> Void
    let onSelectionChange: (NSRange, Double) -> Void
    let onFindResult: (EditorFindResult) -> Void
    let onImageImportRequiresSave: () -> Void

    @State private var adapter: MarkdownEditorAdapter
    @State private var isWikiLinkActive = false
    @State private var pendingInlineReplacement: InlineReplacementRequest?

    init(
        document: DocumentSession,
        settings: AppSettings,
        commandCenter: EditorCommandCenter,
        isActive: Bool = true,
        typewriterMode: Bool = false,
        onSourceChange: @escaping (String) -> Void,
        onSelectionChange: @escaping (NSRange, Double) -> Void,
        onFindResult: @escaping (EditorFindResult) -> Void,
        onImageImportRequiresSave: @escaping () -> Void
    ) {
        self.document = document
        self.settings = settings
        self.commandCenter = commandCenter
        self.isActive = isActive
        self.typewriterMode = typewriterMode
        self.onSourceChange = onSourceChange
        self.onSelectionChange = onSelectionChange
        self.onFindResult = onFindResult
        self.onImageImportRequiresSave = onImageImportRequiresSave

        let adapter = MarkdownEditorAdapter(
            documentID: document.id,
            source: document.source,
            documentURL: document.url,
            mode: document.editorMode,
            themeID: settings.themeID
        )
        adapter.onModeChange = { [weak document] mode in
            document?.editorMode = mode
        }
        adapter.onSelectionChange = { range, offset in
            onSelectionChange(range, offset)
        }
        adapter.onFindResult = onFindResult
        adapter.onImageImportRequiresSave = onImageImportRequiresSave
        _adapter = State(initialValue: adapter)
    }

    var body: some View {
        let descriptor = AppSettings.themes.first(where: { $0.id == settings.themeID })
            ?? AppSettings.themes[0]
        let configuration = adapter.configuration(
            themeID: settings.themeID,
            readingWidth: settings.readingWidth,
            mode: document.editorMode,
            typewriterMode: typewriterMode
        )

        NativeTextViewWrapper(
            text: sourceBinding,
            isWikiLinkActive: $isWikiLinkActive,
            pendingInlineReplacement: $pendingInlineReplacement,
            configuration: configuration,
            fontName: descriptor.bodyFontName,
            fontSize: CGFloat(settings.editorFontSize),
            documentId: document.id.rawValue.uuidString,
            isEditable: true,
            onImportImages: { pasteboard, completion in
                adapter.importImages(from: pasteboard, completion: completion)
            },
            onLinkClick: { target in
                openExternalLink(target)
            },
            onBuildContextMenu: { menu, selection in
                adapter.buildContextMenu(menu, selection: selection)
            },
            onInlineSelectionChange: { state in
                guard let state else { return }
                let range = state.selection.storageRange ?? state.selection.displayRange
                onSelectionChange(range, document.scrollOffset)
            },
            placeholder: placeholder(fontName: descriptor.bodyFontName),
            retainedScrollDocumentIds: [document.id.rawValue.uuidString],
            onPersistScrollOffset: { documentID, offset in
                guard documentID == document.id.rawValue.uuidString else { return }
                adapter.recordScrollOffset(Double(offset))
            },
            restoreScrollOffset: { documentID in
                guard documentID == document.id.rawValue.uuidString else { return nil }
                return CGFloat(document.scrollOffset)
            }
        )
        .opacity(isActive ? 1 : 0)
        .allowsHitTesting(isActive)
        .accessibilityHidden(!isActive)
        .accessibilityIdentifier("markdown-editor-\(document.id.rawValue.uuidString)")
        .zIndex(isActive ? 1 : 0)
        .onAppear {
            installCallbacks()
            adapter.synchronize(
                source: document.source,
                documentURL: document.url,
                mode: document.editorMode
            )
            setActive(isActive, focus: isActive)
        }
        .onDisappear {
            adapter.deactivate()
            commandCenter.unregister(documentID: document.id)
        }
        .onChange(of: isActive) { _, newValue in
            installCallbacks()
            setActive(newValue, focus: newValue)
        }
        .onChange(of: document.url) { _, newValue in
            adapter.synchronize(
                source: document.source,
                documentURL: newValue,
                mode: document.editorMode
            )
        }
        .onChange(of: document.editorMode) { _, newValue in
            adapter.synchronize(
                source: document.source,
                documentURL: document.url,
                mode: newValue
            )
        }
    }

    private var sourceBinding: Binding<String> {
        Binding(
            get: { document.source },
            set: { newValue in
                guard newValue != document.source else { return }
                // AppController owns dirty state, analysis, recovery and autosave.
                // Notify it before synchronizing adapter-only state.
                onSourceChange(newValue)
                adapter.synchronize(
                    source: newValue,
                    documentURL: document.url,
                    mode: document.editorMode
                )
            }
        )
    }

    private func installCallbacks() {
        adapter.onModeChange = { [weak document] mode in
            document?.editorMode = mode
        }
        adapter.onSelectionChange = { range, offset in
            onSelectionChange(range, offset)
        }
        adapter.onFindResult = onFindResult
        adapter.onImageImportRequiresSave = onImageImportRequiresSave
    }

    private func setActive(_ active: Bool, focus: Bool) {
        guard active else {
            adapter.deactivate()
            commandCenter.unregister(documentID: document.id)
            return
        }
        commandCenter.register(adapter)
        adapter.activate()
        guard focus else { return }
        Task { @MainActor in
            await Task.yield()
            adapter.attachToVisibleEditor()
            adapter.perform(.focus)
        }
    }

    private func placeholder(fontName: String) -> NSAttributedString {
        let font = NSFont(name: fontName, size: CGFloat(settings.editorFontSize))
            ?? NSFont.systemFont(ofSize: CGFloat(settings.editorFontSize))
        return NSAttributedString(
            string: String(localized: "Start writing..."),
            attributes: [
                .font: font,
                .foregroundColor: NSColor.tertiaryLabelColor
            ]
        )
    }

    private func openExternalLink(_ target: String) {
        guard let url = URL(string: target),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }
}
