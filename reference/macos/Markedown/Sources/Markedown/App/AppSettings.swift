import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    private enum Key {
        static let theme = "settings.theme"
        static let readingWidth = "settings.readingWidth"
        static let editorFontSize = "settings.editorFontSize"
        static let showToolbar = "settings.showToolbar"
        static let showStatusBar = "settings.showStatusBar"
        static let codeLineNumbers = "settings.codeLineNumbers"
        static let autoSave = "settings.autoSave"
        static let loadRemoteImages = "settings.loadRemoteImages"
        static let rememberWorkspace = "settings.rememberWorkspace"
        static let exportPageSize = "settings.exportPageSize"
        static let exportIncludesOutline = "settings.exportIncludesOutline"
    }

    private let defaults: UserDefaults

    var themeID: EditorThemeID {
        didSet { defaults.set(themeID.rawValue, forKey: Key.theme) }
    }

    var readingWidth: Double {
        didSet { defaults.set(readingWidth, forKey: Key.readingWidth) }
    }

    var editorFontSize: Double {
        didSet { defaults.set(editorFontSize, forKey: Key.editorFontSize) }
    }

    var showToolbar: Bool {
        didSet { defaults.set(showToolbar, forKey: Key.showToolbar) }
    }

    var showStatusBar: Bool {
        didSet { defaults.set(showStatusBar, forKey: Key.showStatusBar) }
    }

    var codeLineNumbers: Bool {
        didSet { defaults.set(codeLineNumbers, forKey: Key.codeLineNumbers) }
    }

    var autoSave: Bool {
        didSet { defaults.set(autoSave, forKey: Key.autoSave) }
    }

    var loadRemoteImages: Bool {
        didSet { defaults.set(loadRemoteImages, forKey: Key.loadRemoteImages) }
    }

    var rememberWorkspace: Bool {
        didSet { defaults.set(rememberWorkspace, forKey: Key.rememberWorkspace) }
    }

    var exportPageSize: String {
        didSet { defaults.set(exportPageSize, forKey: Key.exportPageSize) }
    }

    var exportIncludesOutline: Bool {
        didSet { defaults.set(exportIncludesOutline, forKey: Key.exportIncludesOutline) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        let storedTheme = defaults.string(forKey: Key.theme)
        themeID = storedTheme.flatMap(EditorThemeID.init(rawValue:)) ?? .system

        let storedReadingWidth = defaults.double(forKey: Key.readingWidth)
        readingWidth = storedReadingWidth > 0 ? storedReadingWidth : 720

        let storedFontSize = defaults.double(forKey: Key.editorFontSize)
        editorFontSize = storedFontSize > 0 ? storedFontSize : 17

        showToolbar = defaults.object(forKey: Key.showToolbar) as? Bool ?? true
        showStatusBar = defaults.object(forKey: Key.showStatusBar) as? Bool ?? true
        codeLineNumbers = defaults.object(forKey: Key.codeLineNumbers) as? Bool ?? false
        autoSave = defaults.object(forKey: Key.autoSave) as? Bool ?? true
        loadRemoteImages = defaults.object(forKey: Key.loadRemoteImages) as? Bool ?? false
        rememberWorkspace = defaults.object(forKey: Key.rememberWorkspace) as? Bool ?? true
        exportPageSize = defaults.string(forKey: Key.exportPageSize) ?? "A4"
        exportIncludesOutline = defaults.object(forKey: Key.exportIncludesOutline) as? Bool ?? true
    }

    static let themes: [ThemeDescriptor] = [
        ThemeDescriptor(
            id: .system,
            displayName: String(localized: "Follow System"),
            bodyFontName: "Charter",
            codeFontName: "SF Mono",
            readingWidth: 720
        ),
        ThemeDescriptor(
            id: .paper,
            displayName: String(localized: "Paper"),
            bodyFontName: "Charter",
            codeFontName: "SF Mono",
            readingWidth: 720
        ),
        ThemeDescriptor(
            id: .graphite,
            displayName: String(localized: "Graphite"),
            bodyFontName: "Charter",
            codeFontName: "SF Mono",
            readingWidth: 720
        )
    ]
}
