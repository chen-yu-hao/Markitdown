import AppKit
import SwiftUI

enum MarkedownMetrics {
    static let sidebarWidth: CGFloat = 248
    static let tabBarHeight: CGFloat = 36
    static let statusBarHeight: CGFloat = 27
    static let toolbarHeight: CGFloat = 34
    static let iconButtonSize: CGFloat = 28
    static let compactRadius: CGFloat = 6
}

struct MarkedownPalette {
    let window: Color
    let sidebar: Color
    let editor: Color
    let raised: Color
    let text: Color
    let secondaryText: Color
    let separator: Color
    let accent: Color
    let accentSoft: Color
    let codeBackground: Color

    static func resolve(theme: EditorThemeID, colorScheme: ColorScheme) -> MarkedownPalette {
        let usesDark = theme == .graphite || (theme == .system && colorScheme == .dark)

        if usesDark {
            return MarkedownPalette(
                window: Color(red: 0.105, green: 0.108, blue: 0.114),
                sidebar: Color(red: 0.132, green: 0.137, blue: 0.145),
                editor: Color(red: 0.118, green: 0.121, blue: 0.127),
                raised: Color(red: 0.165, green: 0.170, blue: 0.178),
                text: Color(red: 0.930, green: 0.920, blue: 0.895),
                secondaryText: Color(red: 0.640, green: 0.650, blue: 0.655),
                separator: Color.white.opacity(0.09),
                accent: Color(red: 0.910, green: 0.635, blue: 0.240),
                accentSoft: Color(red: 0.910, green: 0.635, blue: 0.240).opacity(0.16),
                codeBackground: Color.black.opacity(0.24)
            )
        }

        return MarkedownPalette(
            window: Color(red: 0.948, green: 0.953, blue: 0.958),
            sidebar: Color(red: 0.922, green: 0.932, blue: 0.938),
            editor: Color(red: 0.990, green: 0.992, blue: 0.993),
            raised: Color.white,
            text: Color(red: 0.105, green: 0.120, blue: 0.128),
            secondaryText: Color(red: 0.390, green: 0.430, blue: 0.448),
            separator: Color.black.opacity(0.08),
            accent: Color(red: 0.135, green: 0.485, blue: 0.485),
            accentSoft: Color(red: 0.135, green: 0.485, blue: 0.485).opacity(0.13),
            codeBackground: Color(red: 0.925, green: 0.940, blue: 0.945)
        )
    }
}

extension View {
    func markedownIconButton(palette: MarkedownPalette, isActive: Bool = false) -> some View {
        frame(width: MarkedownMetrics.iconButtonSize, height: MarkedownMetrics.iconButtonSize)
            .foregroundStyle(isActive ? palette.accent : palette.secondaryText)
            .background(isActive ? palette.accentSoft : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: MarkedownMetrics.compactRadius, style: .continuous))
            .contentShape(Rectangle())
    }
}

