import SwiftUI

struct FindBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var queryIsFocused: Bool

    @Binding var query: String
    @Binding var replacement: String
    @Binding var showsReplace: Bool
    @Binding var options: EditorFindOptions

    let themeID: EditorThemeID
    let result: EditorFindResult?
    let onFind: () -> Void
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onReplace: () -> Void
    let onReplaceAll: () -> Void
    let onClose: () -> Void

    var body: some View {
        let palette = MarkedownPalette.resolve(theme: themeID, colorScheme: colorScheme)

        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button {
                    showsReplace.toggle()
                } label: {
                    Image(systemName: showsReplace ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .markedownIconButton(palette: palette)
                }
                .buttonStyle(.plain)
                .help("Toggle Replace")

                TextField("Find", text: $query)
                    .textFieldStyle(.plain)
                    .accessibilityIdentifier("find-field")
                    .focused($queryIsFocused)
                    .onSubmit(onNext)
                    .onChange(of: query) { _, _ in onFind() }
                    .frame(minWidth: 190)

                Text(result.map { "\($0.current)/\($0.total)" } ?? "0/0")
                    .font(.system(size: 10.5))
                    .monospacedDigit()
                    .foregroundStyle(palette.secondaryText)
                    .frame(width: 42, alignment: .trailing)

                optionButton("character.case", label: "Match Case", isActive: options.isCaseSensitive, palette: palette) {
                    options.isCaseSensitive.toggle()
                    onFind()
                }
                optionButton("textformat.abc", label: "Whole Word", isActive: options.matchesWholeWord, palette: palette) {
                    options.matchesWholeWord.toggle()
                    onFind()
                }
                optionButton("asterisk", label: "Regular Expression", isActive: options.usesRegularExpression, palette: palette) {
                    options.usesRegularExpression.toggle()
                    onFind()
                }

                navButton(
                    "chevron.up",
                    label: "Previous Match",
                    identifier: "find-previous",
                    palette: palette,
                    action: onPrevious
                )
                navButton(
                    "chevron.down",
                    label: "Next Match",
                    identifier: "find-next",
                    palette: palette,
                    action: onNext
                )
                navButton(
                    "xmark",
                    label: "Close Find",
                    identifier: "find-close",
                    palette: palette,
                    action: onClose
                )
            }

            if showsReplace {
                HStack(spacing: 6) {
                    Color.clear.frame(width: MarkedownMetrics.iconButtonSize)
                    TextField("Replace", text: $replacement)
                        .textFieldStyle(.plain)
                        .accessibilityIdentifier("replace-field")
                        .frame(minWidth: 190)
                    Button("Replace", action: onReplace)
                    Button("Replace All", action: onReplaceAll)
                }
                .controlSize(.small)
            }
        }
        .padding(6)
        .background(palette.raised)
        .overlay {
            RoundedRectangle(cornerRadius: MarkedownMetrics.compactRadius, style: .continuous)
                .stroke(palette.separator, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: MarkedownMetrics.compactRadius, style: .continuous))
        .shadow(color: .black.opacity(0.10), radius: 10, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("find-bar")
        .onAppear { queryIsFocused = true }
    }

    private func optionButton(
        _ symbol: String,
        label: LocalizedStringKey,
        isActive: Bool,
        palette: MarkedownPalette,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .markedownIconButton(palette: palette, isActive: isActive)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityValue(isActive
            ? String(localized: "On")
            : String(localized: "Off"))
    }

    private func navButton(
        _ symbol: String,
        label: LocalizedStringKey,
        identifier: String,
        palette: MarkedownPalette,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .markedownIconButton(palette: palette)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(label)
    }
}
