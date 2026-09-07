import AppKit
import MarkdownEngine

enum SafeInlineHTMLMarkdownExtensions {
    static let relativeFontScale: CGFloat = 0.72

    static var all: [any MarkdownExtension] {
        [SuperscriptMarkdownExtension(), SubscriptMarkdownExtension()]
    }
}

struct SuperscriptMarkdownExtension: MarkdownExtension {
    static let identifier = "safe-inline-html-superscript"

    var id: String { Self.identifier }
    var relativeContentFontScale: CGFloat? { SafeInlineHTMLMarkdownExtensions.relativeFontScale }

    var inline: InlineSyntax? {
        InlineSyntax(open: "<sup>", close: "</sup>")
    }

    func contentAttributes(theme: MarkdownEditorTheme) -> [NSAttributedString.Key: Any] {
        [.superscript: 1]
    }

    func html(childrenHTML: String) -> String {
        "<sup>\(childrenHTML)</sup>"
    }
}

struct SubscriptMarkdownExtension: MarkdownExtension {
    static let identifier = "safe-inline-html-subscript"

    var id: String { Self.identifier }
    var relativeContentFontScale: CGFloat? { SafeInlineHTMLMarkdownExtensions.relativeFontScale }

    var inline: InlineSyntax? {
        InlineSyntax(open: "<sub>", close: "</sub>")
    }

    func contentAttributes(theme: MarkdownEditorTheme) -> [NSAttributedString.Key: Any] {
        [.superscript: -1]
    }

    func html(childrenHTML: String) -> String {
        "<sub>\(childrenHTML)</sub>"
    }
}
