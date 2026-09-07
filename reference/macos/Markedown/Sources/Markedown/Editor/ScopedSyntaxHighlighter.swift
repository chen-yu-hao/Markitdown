import AppKit
import Foundation
import MarkdownEngine
import MarkdownEngineCodeBlocks

/// Gives the shared HighlighterSwift implementation a document-scoped
/// appearance notification so one theme switch does not restyle every open
/// editor once per tab.
final class ScopedSyntaxHighlighter: SyntaxHighlighter, @unchecked Sendable {
    let appearanceDidChangeNotification: Notification.Name?
    private let lock = NSLock()
    private var themeID: EditorThemeID
    private let lightBridge: HighlighterSwiftBridge
    private let darkBridge: HighlighterSwiftBridge

    init(documentID: DocumentID, themeID: EditorThemeID) {
        self.themeID = themeID
        appearanceDidChangeNotification = Notification.Name(
            "com.zhuanz.markedown.editor.\(documentID.rawValue.uuidString.lowercased()).appearance"
        )
        lightBridge = HighlighterSwiftBridge(
            lightTheme: "atom-one-light",
            darkTheme: "atom-one-light",
            autoSwitchAppearance: false,
            lightBackground: NSColor(srgbRed: 0.925, green: 0.940, blue: 0.945, alpha: 1),
            darkBackground: NSColor(srgbRed: 0.925, green: 0.940, blue: 0.945, alpha: 1),
            preferredFontNames: ["SF Mono", "Menlo"]
        )
        darkBridge = HighlighterSwiftBridge(
            lightTheme: "atom-one-dark",
            darkTheme: "atom-one-dark",
            autoSwitchAppearance: false,
            lightBackground: NSColor(srgbRed: 0.105, green: 0.108, blue: 0.114, alpha: 1),
            darkBackground: NSColor(srgbRed: 0.105, green: 0.108, blue: 0.114, alpha: 1),
            preferredFontNames: ["SF Mono", "Menlo"]
        )
    }

    func update(themeID: EditorThemeID) {
        lock.lock()
        self.themeID = themeID
        lock.unlock()
    }

    func codeFont(size: CGFloat) -> NSFont {
        activeBridge.codeFont(size: size)
    }

    func backgroundColor() -> NSColor {
        activeBridge.backgroundColor()
    }

    func highlight(code: String, language: String?) -> NSAttributedString? {
        activeBridge.highlight(code: code, language: language)
    }

    func clearCache() {
        lightBridge.clearCache()
        darkBridge.clearCache()
    }

    private var activeBridge: HighlighterSwiftBridge {
        lock.lock()
        let selectedTheme = themeID
        lock.unlock()
        // MarkdownEngine invokes highlighters while styling its AppKit text view.
        let systemIsDark = MainActor.assumeIsolated {
            let appearance = NSApp.keyWindow?.effectiveAppearance ?? NSApp.effectiveAppearance
            return appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        }
        let usesDark = selectedTheme == .graphite
            || (selectedTheme == .system && systemIsDark)
        return usesDark ? darkBridge : lightBridge
    }
}
