import SwiftUI

struct DocumentStatusBar: View {
    @Environment(\.colorScheme) private var colorScheme

    let source: String
    let statistics: MarkdownStatistics?
    let encoding: DocumentEncoding
    let lineEnding: LineEnding
    let editorMode: EditorMode
    let themeID: EditorThemeID
    let isFocusMode: Bool
    let isTypewriterMode: Bool
    let onToggleFocus: () -> Void
    let onToggleTypewriter: () -> Void

    var body: some View {
        let palette = MarkedownPalette.resolve(theme: themeID, colorScheme: colorScheme)

        HStack(spacing: 14) {
            Text(localizedFormat("status.words", statistics?.wordCount ?? 0))
            Text(localizedFormat("status.characters", statistics?.characterCount ?? source.count))
            Text(localizedFormat("status.lines", statistics?.lineCount ?? fallbackLineCount))
            if let minutes = statistics?.estimatedReadingMinutes, minutes > 0 {
                Text(localizedFormat("status.reading-minutes", minutes))
            }

            Spacer(minLength: 12)

            Text(encoding == .utf8WithBOM ? "UTF-8 BOM" : "UTF-8")
            Text(lineEnding == .crlf ? "CRLF" : "LF")
            Text(editorMode == .source
                ? String(localized: "Source")
                : String(localized: "Live"))
                .accessibilityIdentifier("editor-mode-\(editorMode.rawValue)")

            statusButton(
                symbol: "scope",
                label: "Focus Mode",
                isActive: isFocusMode,
                palette: palette,
                action: onToggleFocus
            )
            statusButton(
                symbol: "text.line.first.and.arrowtriangle.forward",
                label: "Typewriter Mode",
                isActive: isTypewriterMode,
                palette: palette,
                action: onToggleTypewriter
            )
        }
        .font(.system(size: 10.5, weight: .regular))
        .foregroundStyle(palette.secondaryText)
        .padding(.horizontal, 12)
        .frame(height: MarkedownMetrics.statusBarHeight)
        .background(palette.window)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.separator).frame(height: 1)
        }
    }

    private var fallbackLineCount: Int {
        source.isEmpty ? 0 : source.reduce(into: 1) { count, character in
            if character == "\n" { count += 1 }
        }
    }

    private func statusButton(
        symbol: String,
        label: LocalizedStringKey,
        isActive: Bool,
        palette: MarkedownPalette,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 20, height: 20)
                .foregroundStyle(isActive ? palette.accent : palette.secondaryText)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityValue(isActive
            ? String(localized: "On")
            : String(localized: "Off"))
    }
}
