import SwiftUI

struct DocumentTabStrip: View {
    @Environment(\.colorScheme) private var colorScheme

    let documents: [DocumentSession]
    let activeDocumentID: DocumentID?
    let themeID: EditorThemeID
    let onActivate: (DocumentSession) -> Void
    let onClose: (DocumentSession) -> Void
    let onNewDocument: () -> Void

    var body: some View {
        let palette = MarkedownPalette.resolve(theme: themeID, colorScheme: colorScheme)

        HStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(documents) { document in
                        tab(for: document, palette: palette)
                    }
                }
            }
            .scrollIndicators(.hidden)

            Rectangle()
                .fill(palette.separator)
                .frame(width: 1, height: 18)

            Button(action: onNewDocument) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .markedownIconButton(palette: palette)
            }
            .buttonStyle(.plain)
            .help("New Document")
            .accessibilityLabel("New Document")
            .padding(.horizontal, 5)
        }
        .frame(height: MarkedownMetrics.tabBarHeight)
        .background(palette.window)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(palette.separator)
                .frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("document-tab-strip")
    }

    private func tab(for document: DocumentSession, palette: MarkedownPalette) -> some View {
        let isActive = activeDocumentID == document.id

        return HStack(spacing: 0) {
            Button {
                onActivate(document)
            } label: {
                HStack(spacing: 7) {
                Image(systemName: "doc.plaintext")
                    .font(.system(size: 12))
                    .foregroundStyle(isActive ? palette.accent : palette.secondaryText)

                Text(document.displayName)
                    .font(.system(size: 12.5, weight: isActive ? .medium : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(isActive ? palette.text : palette.secondaryText)

                if document.isDirty {
                    Circle()
                        .fill(palette.accent)
                        .frame(width: 5, height: 5)
                        .accessibilityLabel("Unsaved changes")
                }
                }
                .padding(.leading, 11)
                .frame(minWidth: 96, maxWidth: 184, minHeight: MarkedownMetrics.tabBarHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("document-tab")
            .accessibilityLabel(document.displayName)
            .accessibilityValue(document.isDirty
                ? String(localized: "Unsaved")
                : String(localized: "Saved"))

            Button {
                onClose(document)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 22, height: MarkedownMetrics.tabBarHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.secondaryText)
            .help("Close Document")
            .accessibilityLabel("Close Document")
        }
        .frame(minWidth: 120, maxWidth: 210, minHeight: MarkedownMetrics.tabBarHeight)
        .background(isActive ? palette.editor : Color.clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(isActive ? palette.accent : Color.clear)
                .frame(height: 2)
        }
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(palette.separator)
                .frame(width: 1, height: 20)
        }
    }
}
