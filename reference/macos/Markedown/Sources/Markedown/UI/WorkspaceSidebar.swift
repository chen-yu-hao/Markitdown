import SwiftUI

struct WorkspaceSidebar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var controller: AppController

    var body: some View {
        let session = controller.workspaceSession
        let palette = MarkedownPalette.resolve(theme: session.themeID, colorScheme: colorScheme)

        VStack(spacing: 0) {
            sidebarHeader(palette: palette)

            Rectangle()
                .fill(palette.separator)
                .frame(height: 1)

            Group {
                switch session.sidebarMode {
                case .files:
                    filesPane(palette: palette)
                case .outline:
                    outlinePane(palette: palette)
                case .search:
                    searchPane(palette: palette)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 210, idealWidth: MarkedownMetrics.sidebarWidth, maxWidth: 340)
        .background(palette.sidebar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace-sidebar")
    }

    private func sidebarHeader(palette: MarkedownPalette) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(palette.accent)

                Text(controller.workspaceSession.rootURL?.lastPathComponent ?? String(localized: "Workspace"))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(palette.text)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 6)

                Button {
                    controller.chooseFolderToOpen()
                } label: {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 12, weight: .medium))
                        .markedownIconButton(palette: palette)
                }
                .buttonStyle(.plain)
                .help("Open Folder...")
                .accessibilityLabel("Open Folder...")
            }

            HStack(spacing: 3) {
                sidebarModeButton(.files, symbol: "doc.on.doc", label: "Files", palette: palette)
                sidebarModeButton(.outline, symbol: "list.bullet.indent", label: "Outline", palette: palette)
                sidebarModeButton(.search, symbol: "magnifyingglass", label: "Search", palette: palette)
            }
            .padding(3)
            .background(palette.window.opacity(0.52))
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        }
        .padding(.horizontal, 10)
        .padding(.top, 9)
        .padding(.bottom, 8)
    }

    private func sidebarModeButton(
        _ mode: SidebarMode,
        symbol: String,
        label: LocalizedStringKey,
        palette: MarkedownPalette
    ) -> some View {
        let isSelected = controller.workspaceSession.sidebarMode == mode

        return Button {
            controller.workspaceSession.sidebarMode = mode
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                Text(label)
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(isSelected ? palette.text : palette.secondaryText)
            .frame(maxWidth: .infinity, minHeight: 25)
            .background(isSelected ? palette.raised : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
    }

    @ViewBuilder
    private func filesPane(palette: MarkedownPalette) -> some View {
        if controller.workspaceRootNode != nil {
            WorkspaceOutlineView(
                root: controller.workspaceRootNode,
                activeURL: controller.activeDocument?.url,
                onOpenFile: { url in controller.openURL(url) },
                onExpandDirectory: { node in
                    Task { await controller.loadWorkspaceChildren(of: node) }
                }
            )
            .background(palette.sidebar)
        } else {
            SidebarPlaceholder(
                symbol: "folder",
                title: "No Folder Open",
                actionTitle: "Open Folder...",
                palette: palette,
                action: controller.chooseFolderToOpen
            )
        }
    }

    @ViewBuilder
    private func outlinePane(palette: MarkedownPalette) -> some View {
        if controller.outline.isEmpty {
            SidebarPlaceholder(
                symbol: "list.bullet.indent",
                title: "No Headings",
                palette: palette
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(controller.outline) { item in
                        Button {
                            scrollToOutlineItem(item)
                        } label: {
                            HStack(spacing: 7) {
                                Text("H\(item.level)")
                                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(palette.accent)
                                    .frame(width: 18)
                                Text(item.title.isEmpty ? String(localized: "Untitled Heading") : item.title)
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(palette.text)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 4)
                            }
                            .padding(.leading, CGFloat(max(0, item.level - 1)) * 10 + 8)
                            .padding(.trailing, 8)
                            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(item.title)
                    }
                }
                .padding(.vertical, 6)
            }
        }
    }

    private func searchPane(palette: MarkedownPalette) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(palette.secondaryText)

                TextField("Search Workspace", text: $controller.workspaceSearchQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .onSubmit(controller.performWorkspaceSearch)
                    .onChange(of: controller.workspaceSearchQuery) { _, value in
                        controller.searchWorkspace(value)
                    }

                if controller.isSearchingWorkspace {
                    ProgressView().controlSize(.small)
                } else if !controller.workspaceSearchQuery.isEmpty {
                    Button {
                        controller.workspaceSearchQuery = ""
                        controller.cancelWorkspaceSearch()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(palette.secondaryText)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear Search")
                }

                Button {
                    controller.workspaceSearchIsCaseSensitive.toggle()
                    controller.performWorkspaceSearch()
                } label: {
                    Image(systemName: "character.case")
                        .font(.system(size: 11, weight: .medium))
                        .markedownIconButton(
                            palette: palette,
                            isActive: controller.workspaceSearchIsCaseSensitive
                        )
                }
                .buttonStyle(.plain)
                .help("Match Case")
            }
            .padding(.horizontal, 8)
            .frame(height: 40)
            .overlay(alignment: .bottom) {
                Rectangle().fill(palette.separator).frame(height: 1)
            }

            if controller.workspaceSearchResults.isEmpty {
                SidebarPlaceholder(
                    symbol: controller.workspaceSearchQuery.isEmpty ? "text.magnifyingglass" : "magnifyingglass",
                    title: controller.workspaceSearchQuery.isEmpty ? "Search Markdown Files" : "No Results",
                    palette: palette
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(controller.workspaceSearchResults) { result in
                            Button {
                                openSearchResult(result)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(result.fileURL.lastPathComponent)
                                            .font(.system(size: 11.5, weight: .semibold))
                                            .foregroundStyle(palette.text)
                                            .lineLimit(1)
                                        Spacer(minLength: 4)
                                        Text("\(result.line):\(result.column)")
                                            .font(.system(size: 9.5, design: .monospaced))
                                            .foregroundStyle(palette.accent)
                                    }
                                    Text(result.preview)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(palette.secondaryText)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }
                                .padding(.horizontal, 9)
                                .padding(.vertical, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Rectangle().fill(palette.separator).frame(height: 1)
                                .padding(.leading, 9)
                        }
                    }
                }
            }
        }
    }

    private func scrollToOutlineItem(_ item: OutlineItem) {
        guard let source = controller.activeDocument?.source,
              let sourceRange = item.sourceRange else { return }
        controller.commandCenter.activeAdapter?.scrollToSourceLocation(
            sourceRange.lowerBound.utf16Offset(in: source)
        )
    }

    private func openSearchResult(_ result: WorkspaceSearchResult) {
        Task { @MainActor in
            await controller.openFile(at: result.fileURL)
            guard let source = controller.activeDocument?.source else { return }
            var location = 0
            var currentLine = 1
            for scalar in source.unicodeScalars {
                if currentLine == result.line { break }
                location += scalar.utf16.count
                if scalar == "\n" { currentLine += 1 }
            }
            location += max(0, result.column - 1)
            controller.commandCenter.activeAdapter?.scrollToSourceLocation(location)
        }
    }
}

private struct SidebarPlaceholder: View {
    let symbol: String
    let title: LocalizedStringKey
    var actionTitle: LocalizedStringKey?
    let palette: MarkedownPalette
    var action: (() -> Void)?

    init(
        symbol: String,
        title: LocalizedStringKey,
        actionTitle: LocalizedStringKey? = nil,
        palette: MarkedownPalette,
        action: (() -> Void)? = nil
    ) {
        self.symbol = symbol
        self.title = title
        self.actionTitle = actionTitle
        self.palette = palette
        self.action = action
    }

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(palette.secondaryText.opacity(0.75))
            Text(title)
                .font(.system(size: 12.5))
                .foregroundStyle(palette.secondaryText)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }
}
