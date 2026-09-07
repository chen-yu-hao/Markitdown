import Foundation

func localizedFormat(
    _ key: LocalizedStringResource,
    _ arguments: CVarArg...
) -> String {
    String(format: String(localized: key), arguments: arguments)
}
