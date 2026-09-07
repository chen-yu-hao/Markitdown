import Foundation
import MarkdownEngine

/// Notification names are scoped to one document because MarkdownEngine's
/// observers intentionally listen with a nil notification object.
struct MarkdownEditorBusNames: Sendable {
    let applyBold: Notification.Name
    let applyItalic: Notification.Name
    let applyHeading: Notification.Name
    let applyHighlight: Notification.Name
    let applyStrikethrough: Notification.Name
    let applyInlineCode: Notification.Name
    let applyBlockquote: Notification.Name
    let applyUnorderedList: Notification.Name
    let applyOrderedList: Notification.Name
    let applyLink: Notification.Name
    let applyCodeBlock: Notification.Name
    let applyHorizontalRule: Notification.Name
    let applyImage: Notification.Name
    let selectionBoldDidChange: Notification.Name
    let selectionItalicDidChange: Notification.Name
    let selectionHighlightDidChange: Notification.Name
    let findScrollToRange: Notification.Name
    let findClearHighlights: Notification.Name
    let findQuery: Notification.Name
    let findResults: Notification.Name
    let replaceCurrent: Notification.Name
    let replaceAll: Notification.Name

    init(documentID: DocumentID) {
        let prefix = "com.zhuanz.markedown.editor.\(documentID.rawValue.uuidString.lowercased())"
        applyBold = Notification.Name("\(prefix).format.bold")
        applyItalic = Notification.Name("\(prefix).format.italic")
        applyHeading = Notification.Name("\(prefix).format.heading")
        applyHighlight = Notification.Name("\(prefix).format.highlight")
        applyStrikethrough = Notification.Name("\(prefix).format.strikethrough")
        applyInlineCode = Notification.Name("\(prefix).format.inline-code")
        applyBlockquote = Notification.Name("\(prefix).format.blockquote")
        applyUnorderedList = Notification.Name("\(prefix).format.unordered-list")
        applyOrderedList = Notification.Name("\(prefix).format.ordered-list")
        applyLink = Notification.Name("\(prefix).insert.link")
        applyCodeBlock = Notification.Name("\(prefix).insert.code-block")
        applyHorizontalRule = Notification.Name("\(prefix).insert.horizontal-rule")
        applyImage = Notification.Name("\(prefix).insert.image")
        selectionBoldDidChange = Notification.Name("\(prefix).selection.bold")
        selectionItalicDidChange = Notification.Name("\(prefix).selection.italic")
        selectionHighlightDidChange = Notification.Name("\(prefix).selection.highlight")
        findScrollToRange = Notification.Name("\(prefix).find.scroll")
        findClearHighlights = Notification.Name("\(prefix).find.clear")
        findQuery = Notification.Name("\(prefix).find.query")
        findResults = Notification.Name("\(prefix).find.results")
        replaceCurrent = Notification.Name("\(prefix).find.replace-current")
        replaceAll = Notification.Name("\(prefix).find.replace-all")
    }

    var bus: MarkdownEditorBus {
        MarkdownEditorBus(
            applyBoldRequest: applyBold,
            applyItalicRequest: applyItalic,
            applyHeadingRequest: applyHeading,
            applyHighlightRequest: applyHighlight,
            applyStrikethroughRequest: applyStrikethrough,
            applyInlineCodeRequest: applyInlineCode,
            applyBlockquoteRequest: applyBlockquote,
            applyUnorderedListRequest: applyUnorderedList,
            applyOrderedListRequest: applyOrderedList,
            applyLinkRequest: applyLink,
            applyCodeBlockRequest: applyCodeBlock,
            applyHorizontalRuleRequest: applyHorizontalRule,
            applyImageRequest: applyImage,
            selectionBoldDidChange: selectionBoldDidChange,
            selectionItalicDidChange: selectionItalicDidChange,
            selectionHighlightDidChange: selectionHighlightDidChange,
            findScrollToRange: findScrollToRange,
            findClearHighlights: findClearHighlights,
            findQuery: findQuery,
            findResults: findResults,
            replaceCurrent: replaceCurrent,
            replaceAll: replaceAll
        )
    }
}
