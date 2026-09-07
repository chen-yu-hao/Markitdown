import SwiftUI

struct WorkspaceView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var controller: AppController
    @State private var findOptions = EditorFindOptions()
    @State private var showsReplace = false
    @State private var isFileDropTargeted = false

    var body: some View {
        let session = controller.workspaceSession
        let palette = MarkedownPalette.resolve(theme: session.themeID, colorScheme: colorScheme)

        HStack(spacing: 0) {
            if session.isSidebarVisible && !session.isFocusMode {
                WorkspaceSidebar(controller: controller)
                    .transition(.move(edge: .leading).combined(with: .opacity))

                Rectangle()
                    .fill(palette.separator)
                    .frame(width: 1)
            }

            VStack(spacing: 0) {
                if !session.isFocusMode {
                    DocumentTabStrip(
                        documents: session.documents,
                        activeDocumentID: session.activeDocumentID,
                        themeID: session.themeID,
                        onActivate: { controller.activateDocument($0.id) },
                        onClose: { document in
                            Task { _ = await controller.closeDocument(document.id) }
                        },
                        onNewDocument: controller.newDocument
                    )
                }

                editorArea(palette: palette)

                if controller.settings.showStatusBar,
                   let document = controller.activeDocument,
                   !session.isFocusMode {
                    DocumentStatusBar(
                        source: document.source,
                        statistics: controller.statistics,
                        encoding: document.encoding,
                        lineEnding: document.lineEnding,
                        editorMode: document.editorMode,
                        themeID: session.themeID,
                        isFocusMode: session.isFocusMode,
                        isTypewriterMode: session.isTypewriterMode,
                        onToggleFocus: controller.toggleFocusMode,
                        onToggleTypewriter: controller.toggleTypewriterMode
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(palette.window)
        .animation(.easeOut(duration: 0.16), value: session.isSidebarVisible)
        .dropDestination(for: URL.self) { urls, _ in
            controller.openDroppedFiles(urls)
        } isTargeted: { isTargeted in
            isFileDropTargeted = isTargeted
        }
        .overlay {
            if isFileDropTargeted {
                FileDropOverlay(palette: palette)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeOut(duration: 0.12), value: isFileDropTargeted)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-workspace")
        .accessibilityValue(controller.activeDocument?.editorMode.rawValue ?? "none")
        .toolbar { windowToolbar(palette: palette) }
        .alert(item: $controller.notice) { notice in
            Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("OK"), action: controller.dismissNotice)
            )
        }
        .alert(
            controller.pendingConflict?.title ?? "",
            isPresented: Binding(
                get: { controller.pendingConflict != nil },
                set: { if !$0 { controller.cancelConflict() } }
            ),
            presenting: controller.pendingConflict
        ) { conflict in
            if conflict.reason == .changed {
                Button("Reload", action: controller.reloadConflictDocument)
            }
            Button("Save a Copy...", action: controller.saveConflictCopy)
            Button("Cancel", role: .cancel, action: controller.cancelConflict)
        } message: { conflict in
            Text(conflict.message)
        }
        .onChange(of: controller.settings.themeID) { _, theme in
            session.themeID = theme
        }
        .onChange(of: controller.settings.showToolbar) { _, isVisible in
            session.isToolbarVisible = isVisible
        }
    }

    @ViewBuilder
    private func editorArea(palette: MarkedownPalette) -> some View {
        if controller.workspaceSession.documents.isEmpty {
            EmptyEditorView(palette: palette) {
                controller.chooseFilesToOpen()
            }
        } else {
            ZStack {
                ForEach(controller.workspaceSession.documents) { document in
                    let isActive = document.id == controller.workspaceSession.activeDocumentID
                    MarkdownEditorView(
                        document: document,
                        settings: controller.settings,
                        commandCenter: controller.commandCenter,
                        isActive: isActive,
                        typewriterMode: controller.workspaceSession.isTypewriterMode,
                        onSourceChange: { controller.updateSource($0, for: document.id) },
                        onSelectionChange: {
                            controller.updateSelection($0, scrollOffset: $1, for: document.id)
                        },
                        onFindResult: { result in
                            if isActive { controller.findResult = result }
                        },
                        onImageImportRequiresSave: controller.presentImageImportRequiresSave
                    )
                    .opacity(isActive ? 1 : 0)
                    .allowsHitTesting(isActive)
                    .accessibilityHidden(!isActive)
                }
            }
            .background(palette.editor)
            .overlay(alignment: .top) {
                overlayControls
            }
        }
    }

    private var overlayControls: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 16)

            VStack(alignment: .trailing, spacing: 8) {
                if controller.workspaceSession.isToolbarVisible,
                   !controller.workspaceSession.isFocusMode {
                    FormattingToolbar(
                        commandCenter: controller.commandCenter,
                        themeID: controller.workspaceSession.themeID
                    )
                }

                if controller.isFindBarVisible {
                    FindBar(
                        query: $controller.findQuery,
                        replacement: $controller.replacementText,
                        showsReplace: $showsReplace,
                        options: $findOptions,
                        themeID: controller.workspaceSession.themeID,
                        result: controller.findResult,
                        onFind: {
                            controller.commandCenter.activeAdapter?.find(
                                controller.findQuery,
                                options: findOptions
                            )
                        },
                        onPrevious: {
                            controller.commandCenter.activeAdapter?.findPrevious()
                        },
                        onNext: {
                            controller.commandCenter.activeAdapter?.findNext()
                        },
                        onReplace: controller.replaceCurrentFindResult,
                        onReplaceAll: {
                            controller.commandCenter.activeAdapter?.replaceAll(
                                query: controller.findQuery,
                                replacement: controller.replacementText,
                                options: findOptions
                            )
                        },
                        onClose: controller.closeFind
                    )
                }
            }
            .frame(maxWidth: 650, alignment: .trailing)
        }
        .padding(.top, 10)
        .padding(.horizontal, 12)
    }

    @ToolbarContentBuilder
    private func windowToolbar(palette: MarkedownPalette) -> some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button {
                controller.toggleSidebar()
            } label: {
                Image(systemName: "sidebar.leading")
            }
            .help(controller.workspaceSession.isSidebarVisible
                ? String(localized: "Hide Sidebar")
                : String(localized: "Show Sidebar"))
            .accessibilityLabel("Toggle Sidebar")

            Button {
                controller.chooseFilesToOpen()
            } label: {
                Image(systemName: "doc.badge.plus")
            }
            .help("Open File...")
            .accessibilityLabel("Open File...")
        }

        ToolbarItem(placement: .principal) {
            HStack(spacing: 8) {
                Text(controller.activeDocument?.displayName ?? "Markedown")
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(1)
                if controller.activeDocument?.isDirty == true {
                    Circle().fill(palette.accent).frame(width: 5, height: 5)
                }
            }
            .frame(maxWidth: 360)
        }

        ToolbarItemGroup(placement: .primaryAction) {
            HStack(spacing: 2) {
                modeButton(.live, symbol: "text.page", label: "Live Preview", palette: palette)
                modeButton(.source, symbol: "chevron.left.forwardslash.chevron.right", label: "Source Mode", palette: palette)
            }

            Button {
                controller.showFind()
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .help("Find")
            .accessibilityLabel("Find")

            Button {
                controller.toggleFocusMode()
            } label: {
                Image(systemName: "scope")
                    .foregroundStyle(controller.workspaceSession.isFocusMode ? palette.accent : .secondary)
            }
            .help("Focus Mode")
            .accessibilityLabel("Focus Mode")
        }
    }

    private func modeButton(
        _ mode: EditorMode,
        symbol: String,
        label: LocalizedStringKey,
        palette: MarkedownPalette
    ) -> some View {
        let isSelected = controller.activeDocument?.editorMode == mode
        return Button {
            controller.setEditorMode(mode)
        } label: {
            Image(systemName: symbol)
                .foregroundStyle(isSelected ? palette.accent : .secondary)
        }
        .help(label)
        .accessibilityIdentifier(mode == .live ? "live-preview-mode" : "source-mode")
        .accessibilityLabel(label)
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
    }
}

private struct FileDropOverlay: View {
    let palette: MarkedownPalette

    var body: some View {
        ZStack {
            Rectangle()
                .fill(palette.editor.opacity(0.92))

            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(
                    palette.accent,
                    style: StrokeStyle(lineWidth: 2, dash: [8, 6])
                )
                .padding(10)

            VStack(spacing: 10) {
                Image(systemName: "arrow.down.doc")
                    .font(.system(size: 30, weight: .light))
                Text("Drop Markdown files to open")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(palette.accent)
        }
        .accessibilityHidden(true)
    }
}

private struct EmptyEditorView: View {
    let palette: MarkedownPalette
    let onOpen: () -> Void

    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: "doc.text")
                .font(.system(size: 38, weight: .ultraLight))
                .foregroundStyle(palette.accent)
            Text("No document open")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(palette.text)
            Text("Open a Markdown file or create a new document.")
                .font(.system(size: 12.5))
                .foregroundStyle(palette.secondaryText)
            Button("Open File...", action: onOpen)
                .keyboardShortcut("o", modifiers: .command)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.editor)
    }
}
