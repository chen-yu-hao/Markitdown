import AppKit
import Foundation
import MarkdownEngine

/// Keeps the NSColor instances stable while allowing a live app-theme switch.
/// MarkdownEngine 0.12.0 retains its initial theme in the coordinator, so
/// replacing the configuration value alone would not recolor a mounted editor.
final class MarkdownEditorThemeState: @unchecked Sendable {
    private enum Role: Sendable {
        case body
        case muted
        case disabled
        case heading
        case link
        case incompleteLink
        case findMatch
        case findCurrent
        case latexLight
        case latexDark
        case strikethrough
        case highlight
    }

    private let lock = NSLock()
    private var themeID: EditorThemeID

    init(themeID: EditorThemeID) {
        self.themeID = themeID
    }

    @discardableResult
    func update(themeID: EditorThemeID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard self.themeID != themeID else { return false }
        self.themeID = themeID
        return true
    }

    lazy var theme = MarkdownEditorTheme(
        bodyText: dynamic(.body),
        mutedText: dynamic(.muted),
        disabledText: dynamic(.disabled),
        headingMarker: dynamic(.heading),
        link: dynamic(.link),
        incompleteLink: dynamic(.incompleteLink),
        findMatchHighlight: dynamic(.findMatch),
        findCurrentMatchHighlight: dynamic(.findCurrent),
        latexLightModeText: dynamic(.latexLight),
        latexDarkModeText: dynamic(.latexDark),
        strikethroughColor: dynamic(.strikethrough),
        highlightColor: dynamic(.highlight)
    )

    private func dynamic(_ role: Role) -> NSColor {
        NSColor(name: nil) { [weak self] appearance in
            self?.color(for: role, appearance: appearance) ?? .labelColor
        }
    }

    private func color(for role: Role, appearance: NSAppearance) -> NSColor {
        lock.lock()
        let selectedTheme = themeID
        lock.unlock()

        let followsDarkAppearance = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let usesGraphite = selectedTheme == .graphite
            || (selectedTheme == .system && followsDarkAppearance)
        return usesGraphite ? graphiteColor(for: role) : paperColor(for: role)
    }

    private func paperColor(for role: Role) -> NSColor {
        let text = NSColor(srgbRed: 0.105, green: 0.120, blue: 0.128, alpha: 1)
        let secondary = NSColor(srgbRed: 0.390, green: 0.430, blue: 0.448, alpha: 1)
        let teal = NSColor(srgbRed: 0.135, green: 0.485, blue: 0.485, alpha: 1)
        switch role {
        case .body, .latexLight, .latexDark:
            return text
        case .muted, .strikethrough:
            return secondary
        case .disabled:
            return NSColor(srgbRed: 0.610, green: 0.635, blue: 0.645, alpha: 1)
        case .heading, .link:
            return teal
        case .incompleteLink:
            return teal.withAlphaComponent(0.70)
        case .findMatch:
            return teal.withAlphaComponent(0.28)
        case .findCurrent:
            return teal.withAlphaComponent(0.50)
        case .highlight:
            return NSColor(srgbRed: 0.945, green: 0.800, blue: 0.330, alpha: 0.42)
        }
    }

    private func graphiteColor(for role: Role) -> NSColor {
        let text = NSColor(srgbRed: 0.930, green: 0.920, blue: 0.895, alpha: 1)
        let secondary = NSColor(srgbRed: 0.640, green: 0.650, blue: 0.655, alpha: 1)
        let amber = NSColor(srgbRed: 0.910, green: 0.635, blue: 0.240, alpha: 1)
        switch role {
        case .body, .latexLight, .latexDark:
            return text
        case .muted, .strikethrough:
            return secondary
        case .disabled:
            return NSColor(srgbRed: 0.420, green: 0.430, blue: 0.440, alpha: 1)
        case .heading, .link:
            return amber
        case .incompleteLink:
            return amber.withAlphaComponent(0.72)
        case .findMatch:
            return amber.withAlphaComponent(0.25)
        case .findCurrent:
            return amber.withAlphaComponent(0.52)
        case .highlight:
            return amber.withAlphaComponent(0.32)
        }
    }
}
