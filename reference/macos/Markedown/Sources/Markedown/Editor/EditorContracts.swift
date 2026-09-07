import Foundation
import Observation

enum EditorCommand: String, CaseIterable, Sendable {
    case paragraph
    case heading1
    case heading2
    case heading3
    case heading4
    case heading5
    case heading6
    case strong
    case emphasis
    case strikethrough
    case highlight
    case inlineCode
    case link
    case image
    case blockquote
    case unorderedList
    case orderedList
    case taskList
    case codeBlock
    case horizontalRule
    case undo
    case redo
    case selectAll
    case focus
}

struct EditorFindOptions: Hashable, Sendable {
    var isCaseSensitive = false
    var matchesWholeWord = false
    var usesRegularExpression = false
}

struct EditorFindResult: Hashable, Sendable {
    let current: Int
    let total: Int
}

@MainActor
protocol EditorAdapter: AnyObject {
    var documentID: DocumentID { get }
    var selectedRange: NSRange { get }
    var scrollOffset: Double { get }
    var currentFindResult: EditorFindResult? { get }

    func perform(_ command: EditorCommand)
    func setMode(_ mode: EditorMode)
    func find(_ query: String, options: EditorFindOptions)
    func findNext()
    func findPrevious()
    func clearFind()
    func replaceCurrent(with replacement: String)
    func replaceAll(query: String, replacement: String, options: EditorFindOptions)
    func scrollToSourceLocation(_ location: Int)
}

extension EditorAdapter {
    var currentFindResult: EditorFindResult? { nil }
    func findNext() {}
    func findPrevious() {}
    func clearFind() {}
}

@MainActor
@Observable
final class EditorCommandCenter {
    private(set) weak var activeAdapter: (any EditorAdapter)?

    func register(_ adapter: any EditorAdapter) {
        activeAdapter = adapter
    }

    func unregister(documentID: DocumentID) {
        guard activeAdapter?.documentID == documentID else { return }
        activeAdapter = nil
    }

    func perform(_ command: EditorCommand) {
        activeAdapter?.perform(command)
    }
}
