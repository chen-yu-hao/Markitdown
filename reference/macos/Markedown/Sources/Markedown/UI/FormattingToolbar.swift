import SwiftUI

struct FormattingToolbar: View {
    @Environment(\.colorScheme) private var colorScheme

    let commandCenter: EditorCommandCenter
    let themeID: EditorThemeID

    private struct Tool: Identifiable {
        let id: EditorCommand
        let symbol: String
        let label: LocalizedStringKey
    }

    private let inlineTools: [Tool] = [
        Tool(id: .strong, symbol: "bold", label: "Bold"),
        Tool(id: .emphasis, symbol: "italic", label: "Italic"),
        Tool(id: .strikethrough, symbol: "strikethrough", label: "Strikethrough"),
        Tool(id: .inlineCode, symbol: "chevron.left.forwardslash.chevron.right", label: "Inline Code")
    ]

    private let insertTools: [Tool] = [
        Tool(id: .link, symbol: "link", label: "Link"),
        Tool(id: .image, symbol: "photo", label: "Image"),
        Tool(id: .blockquote, symbol: "text.quote", label: "Block Quote")
    ]

    private let listTools: [Tool] = [
        Tool(id: .unorderedList, symbol: "list.bullet", label: "Bullet List"),
        Tool(id: .orderedList, symbol: "list.number", label: "Numbered List"),
        Tool(id: .taskList, symbol: "checklist", label: "Task List")
    ]

    var body: some View {
        let palette = MarkedownPalette.resolve(theme: themeID, colorScheme: colorScheme)

        HStack(spacing: 2) {
            toolGroup(inlineTools, palette: palette)
            divider(palette: palette)
            toolGroup(insertTools, palette: palette)
            divider(palette: palette)
            toolGroup(listTools, palette: palette)
        }
        .padding(.horizontal, 5)
        .frame(height: MarkedownMetrics.toolbarHeight)
        .background(palette.raised.opacity(colorScheme == .dark ? 0.96 : 0.92))
        .overlay {
            RoundedRectangle(cornerRadius: MarkedownMetrics.compactRadius, style: .continuous)
                .stroke(palette.separator, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: MarkedownMetrics.compactRadius, style: .continuous))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.22 : 0.10), radius: 12, y: 5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Formatting Toolbar")
    }

    @ViewBuilder
    private func toolGroup(_ tools: [Tool], palette: MarkedownPalette) -> some View {
        ForEach(tools) { tool in
            Button {
                commandCenter.perform(tool.id)
            } label: {
                Image(systemName: tool.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .markedownIconButton(palette: palette)
            }
            .buttonStyle(.plain)
            .help(tool.label)
            .accessibilityLabel(tool.label)
        }
    }

    private func divider(palette: MarkedownPalette) -> some View {
        Rectangle()
            .fill(palette.separator)
            .frame(width: 1, height: 16)
            .padding(.horizontal, 3)
    }
}

