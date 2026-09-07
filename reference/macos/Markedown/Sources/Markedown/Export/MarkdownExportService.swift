import Foundation
import Markdown

struct HTMLExportHeading: Hashable, Sendable {
    let title: String
    let level: Int
    let anchor: String
}

struct HTMLExportDocument: Hashable, Sendable {
    let html: String
    let bodyHTML: String
    let headings: [HTMLExportHeading]

    var data: Data {
        Data(html.utf8)
    }
}

enum HTMLRenderExportTarget: String, Hashable, Sendable {
    case pdf
    case image
}

struct HTMLRenderExportRequest: Hashable, Sendable {
    let target: HTMLRenderExportTarget
    let htmlData: Data
    let pageSize: String
}

@MainActor
protocol HTMLRenderExporting: AnyObject {
    func export(_ request: HTMLRenderExportRequest, to destinationURL: URL) async throws
}

enum HTMLRenderExportError: LocalizedError, Equatable {
    case unsupportedFormat(ExportFormat)

    var errorDescription: String? {
        switch self {
        case .unsupportedFormat(let format):
            localizedFormat("error.export.web-unsupported", format.rawValue)
        }
    }
}

struct MarkdownExportService: Sendable {
    func makeHTMLDocument(
        markdown: String,
        title: String = "Untitled",
        options: ExportOptions = ExportOptions()
    ) -> HTMLExportDocument {
        makeHTMLDocument(
            markdown: markdown,
            title: title,
            includeStyles: options.includeStyles,
            theme: options.themeID,
            includeOutline: options.includeOutline,
            allowsRemoteImages: options.allowsRemoteImages
        )
    }

    func makeHTMLDocument(
        markdown: String,
        title: String = "Untitled",
        includeStyles: Bool,
        theme: EditorThemeID,
        includeOutline: Bool = true,
        allowsRemoteImages: Bool = false
    ) -> HTMLExportDocument {
        let document = Document(parsing: markdown)
        var renderer = SafeHTMLRenderer(allowsRemoteImages: allowsRemoteImages)
        renderer.visit(document)

        let outlineHTML = includeOutline
            ? Self.makeOutlineHTML(renderer.headings)
            : ""
        let styleHTML = includeStyles
            ? "<style>\n\(Self.styles(for: theme))\n</style>"
            : ""
        let escapedTitle = Self.escapeText(title)
        let bodyHTML = """
        <div class="export-layout">
        \(outlineHTML)
        <main id="document" class="markdown-body" aria-label="Document">
        \(renderer.result)
        </main>
        </div>
        """
        let imageSources = allowsRemoteImages ? "data: file: https: http:" : "data: file:"
        let html = """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; img-src \(imageSources); media-src data: file:; font-src data:; style-src 'unsafe-inline'">
        <meta name="referrer" content="no-referrer">
        <title>\(escapedTitle)</title>
        \(styleHTML)
        </head>
        <body class="theme-\(theme.rawValue)">
        \(bodyHTML)
        </body>
        </html>
        """

        return HTMLExportDocument(
            html: html,
            bodyHTML: bodyHTML,
            headings: renderer.headings
        )
    }

    func makeHTMLData(
        markdown: String,
        title: String = "Untitled",
        options: ExportOptions = ExportOptions()
    ) -> Data {
        makeHTMLDocument(markdown: markdown, title: title, options: options).data
    }

    func makeStyledHTMLData(
        markdown: String,
        title: String = "Untitled",
        theme: EditorThemeID = .system,
        includeOutline: Bool = true
    ) -> Data {
        makeHTMLDocument(
            markdown: markdown,
            title: title,
            includeStyles: true,
            theme: theme,
            includeOutline: includeOutline
        ).data
    }

    func makeUnstyledHTMLData(
        markdown: String,
        title: String = "Untitled",
        includeOutline: Bool = true
    ) -> Data {
        makeHTMLDocument(
            markdown: markdown,
            title: title,
            includeStyles: false,
            theme: .system,
            includeOutline: includeOutline
        ).data
    }

    func makeRenderRequest(
        markdown: String,
        title: String = "Untitled",
        format: ExportFormat,
        options: ExportOptions = ExportOptions()
    ) throws -> HTMLRenderExportRequest {
        let target: HTMLRenderExportTarget
        switch format {
        case .pdf:
            target = .pdf
        case .image:
            target = .image
        case .html, .docx, .epub, .latex, .rtf, .odt:
            throw HTMLRenderExportError.unsupportedFormat(format)
        }

        return HTMLRenderExportRequest(
            target: target,
            htmlData: makeHTMLData(markdown: markdown, title: title, options: options),
            pageSize: options.pageSize
        )
    }

    private static func makeOutlineHTML(_ headings: [HTMLExportHeading]) -> String {
        guard !headings.isEmpty else { return "" }
        let links = headings.map { heading in
            "<li class=\"outline-level-\(heading.level)\"><a href=\"#\(escapeAttribute(heading.anchor))\">\(escapeText(heading.title))</a></li>"
        }.joined(separator: "\n")

        return """
        <nav class="document-outline" aria-label="Table of contents">
        <ol>
        \(links)
        </ol>
        </nav>
        """
    }

    private static func styles(for theme: EditorThemeID) -> String {
        let palette: String
        switch theme {
        case .system:
            palette = """
            :root { color-scheme: light dark; --page: #ffffff; --text: #202124; --muted: #656b73; --line: #d8dadd; --code: #f3f4f5; --link: #1769aa; }
            @media (prefers-color-scheme: dark) { :root { --page: #1f2022; --text: #e7e8ea; --muted: #a5a9b0; --line: #44474c; --code: #292b2e; --link: #72b7e8; } }
            """
        case .paper:
            palette = """
            :root { color-scheme: light; --page: #fbfbfa; --text: #242526; --muted: #6e7074; --line: #d9d9d5; --code: #f0f0ed; --link: #245f8f; }
            """
        case .graphite:
            palette = """
            :root { color-scheme: dark; --page: #202124; --text: #e7e8ea; --muted: #a8abb0; --line: #47494d; --code: #292b2e; --link: #79b9e6; }
            """
        }

        return palette + """

        * { box-sizing: border-box; }
        html { background: var(--page); color: var(--text); font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        body { margin: 0; background: var(--page); color: var(--text); }
        .export-layout { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 100vh; }
        .markdown-body { width: min(100% - 48px, 760px); margin: 0 auto; padding: 64px 0 96px; overflow-wrap: anywhere; }
        .document-outline { position: fixed; inset: 0 auto 0 0; width: min(280px, 28vw); overflow: auto; padding: 28px 20px; border-right: 1px solid var(--line); background: var(--page); }
        .document-outline + .markdown-body { transform: translateX(min(140px, 14vw)); }
        .document-outline ol { margin: 0; padding: 0; list-style: none; }
        .document-outline li { margin: 5px 0; }
        .document-outline .outline-level-2 { padding-left: 12px; }
        .document-outline .outline-level-3 { padding-left: 24px; }
        .document-outline .outline-level-4 { padding-left: 36px; }
        .document-outline .outline-level-5 { padding-left: 48px; }
        .document-outline .outline-level-6 { padding-left: 60px; }
        .document-outline a { color: var(--muted); text-decoration: none; }
        .document-outline a:hover { color: var(--text); }
        h1, h2, h3, h4, h5, h6 { margin: 1.55em 0 0.55em; line-height: 1.25; scroll-margin-top: 24px; }
        h1 { font-size: 2em; } h2 { font-size: 1.55em; } h3 { font-size: 1.28em; }
        p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
        a { color: var(--link); }
        sup, sub { font-size: 72%; line-height: 0; }
        sup { vertical-align: super; }
        sub { vertical-align: sub; }
        blockquote { margin-left: 0; padding: 0.15em 1em; color: var(--muted); border-left: 3px solid var(--line); }
        code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        code { padding: 0.12em 0.32em; border-radius: 3px; background: var(--code); }
        pre { overflow: auto; padding: 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--code); }
        pre code { padding: 0; background: transparent; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px 10px; border: 1px solid var(--line); text-align: left; }
        img { max-width: 100%; height: auto; }
        hr { margin: 2em 0; border: 0; border-top: 1px solid var(--line); }
        .raw-html { white-space: pre-wrap; color: var(--muted); }
        @media (max-width: 900px) { .document-outline { position: static; width: auto; border-right: 0; border-bottom: 1px solid var(--line); } .document-outline + .markdown-body { transform: none; } }
        @media print { .document-outline { position: static; width: auto; border: 0; page-break-after: always; } .document-outline + .markdown-body { transform: none; } .markdown-body { width: auto; padding: 0; } }
        """
    }

    fileprivate static func escapeText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    fileprivate static func escapeAttribute(_ value: String) -> String {
        escapeText(value)
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

struct PandocCommand: Hashable, Sendable {
    let executableURL: URL
    let arguments: [String]
}

struct PandocExecutionResult: Hashable, Sendable {
    let terminationStatus: Int32
    let standardError: String
}

enum PandocExportError: LocalizedError, Equatable {
    case unsupportedFormat(ExportFormat)
    case invalidExecutable(URL)
    case invalidFileURL(URL)
    case processFailed(status: Int32, message: String)

    var errorDescription: String? {
        switch self {
        case .unsupportedFormat(let format):
            localizedFormat("error.pandoc.unsupported", format.rawValue)
        case .invalidExecutable(let url):
            localizedFormat("error.pandoc.invalid-executable", url.path)
        case .invalidFileURL(let url):
            localizedFormat("error.pandoc.invalid-file-url", url.path)
        case .processFailed(let status, let message):
            localizedFormat("error.pandoc.process-failed", Int(status), message)
        }
    }
}

struct PandocCommandAdapter: Sendable {
    let executableURL: URL

    init(executableURL: URL = URL(fileURLWithPath: "/usr/local/bin/pandoc")) {
        self.executableURL = executableURL
    }

    func command(
        inputURL: URL,
        outputURL: URL,
        format: ExportFormat,
        options: ExportOptions = ExportOptions()
    ) throws -> PandocCommand {
        guard executableURL.isFileURL, executableURL.path.hasPrefix("/") else {
            throw PandocExportError.invalidExecutable(executableURL)
        }
        guard
            inputURL.isFileURL,
            outputURL.isFileURL,
            inputURL.path.hasPrefix("/"),
            outputURL.path.hasPrefix("/")
        else {
            throw PandocExportError.invalidFileURL(inputURL.isFileURL ? outputURL : inputURL)
        }
        guard let target = format.pandocTarget else {
            throw PandocExportError.unsupportedFormat(format)
        }

        var arguments = [
            "--from", "gfm",
            "--to", target,
            "--standalone"
        ]
        if options.includeOutline {
            arguments.append("--toc")
        }
        arguments += [
            "--output", outputURL.standardizedFileURL.path,
            inputURL.standardizedFileURL.path
        ]

        return PandocCommand(executableURL: executableURL, arguments: arguments)
    }

    @discardableResult
    func run(_ command: PandocCommand) throws -> PandocExecutionResult {
        guard command.executableURL.isFileURL, command.executableURL.path.hasPrefix("/") else {
            throw PandocExportError.invalidExecutable(command.executableURL)
        }

        let process = Process()
        let standardError = Pipe()
        process.executableURL = command.executableURL
        process.arguments = command.arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = standardError

        try process.run()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let errorText = String(decoding: errorData, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard process.terminationStatus == 0 else {
            throw PandocExportError.processFailed(
                status: process.terminationStatus,
                message: errorText
            )
        }

        return PandocExecutionResult(
            terminationStatus: process.terminationStatus,
            standardError: errorText
        )
    }
}

private extension ExportFormat {
    var pandocTarget: String? {
        switch self {
        case .docx: "docx"
        case .epub: "epub3"
        case .latex: "latex"
        case .rtf: "rtf"
        case .odt: "odt"
        case .html, .pdf, .image: nil
        }
    }
}

private struct SafeHTMLRenderer: MarkupWalker {
    private struct PendingInlineHTMLTag {
        let tag: SafeInlineHTMLTag
        let openerOffset: Int
        let placeholderLength: Int
    }

    let allowsRemoteImages: Bool
    private(set) var result = ""
    private(set) var headings: [HTMLExportHeading] = []
    private var slugger = HeadingSlugger()
    private var inTableHead = false
    private var tableColumnAlignments: [Table.ColumnAlignment?]?
    private var currentTableColumn = 0
    private var pendingInlineHTMLTags: [PendingInlineHTMLTag] = []

    init(allowsRemoteImages: Bool) {
        self.allowsRemoteImages = allowsRemoteImages
    }

    mutating func visitBlockQuote(_ blockQuote: BlockQuote) {
        result += "<blockquote>\n"
        descendInto(blockQuote)
        result += "</blockquote>\n"
    }

    mutating func visitCodeBlock(_ codeBlock: CodeBlock) {
        let languageAttribute = codeBlock.language.map {
            " class=\"language-\(MarkdownExportService.escapeAttribute($0))\""
        } ?? ""
        result += "<pre><code\(languageAttribute)>\(MarkdownExportService.escapeText(codeBlock.code))</code></pre>\n"
    }

    mutating func visitHeading(_ heading: Heading) {
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        let title = heading.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
        let anchor = slugger.slug(for: title)
        headings.append(HTMLExportHeading(title: title, level: heading.level, anchor: anchor))
        result += "<h\(heading.level) id=\"\(MarkdownExportService.escapeAttribute(anchor))\">"
        descendInto(heading)
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        result += "</h\(heading.level)>\n"
    }

    mutating func visitThematicBreak(_ thematicBreak: ThematicBreak) {
        result += "<hr>\n"
    }

    mutating func visitHTMLBlock(_ html: HTMLBlock) {
        result += "<pre class=\"raw-html\"><code>\(MarkdownExportService.escapeText(html.rawHTML))</code></pre>\n"
    }

    mutating func visitListItem(_ listItem: ListItem) {
        result += "<li>"
        if let checkbox = listItem.checkbox {
            let checked = checkbox == .checked ? " checked" : ""
            result += "<input type=\"checkbox\" disabled\(checked)> "
        }
        descendInto(listItem)
        result += "</li>\n"
    }

    mutating func visitOrderedList(_ orderedList: OrderedList) {
        let start = orderedList.startIndex == 1 ? "" : " start=\"\(orderedList.startIndex)\""
        result += "<ol\(start)>\n"
        descendInto(orderedList)
        result += "</ol>\n"
    }

    mutating func visitUnorderedList(_ unorderedList: UnorderedList) {
        result += "<ul>\n"
        descendInto(unorderedList)
        result += "</ul>\n"
    }

    mutating func visitParagraph(_ paragraph: Paragraph) {
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        result += "<p>"
        descendInto(paragraph)
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        result += "</p>\n"
    }

    mutating func visitTable(_ table: Table) {
        result += "<table>\n"
        tableColumnAlignments = table.columnAlignments
        descendInto(table)
        tableColumnAlignments = nil
        result += "</table>\n"
    }

    mutating func visitTableHead(_ tableHead: Table.Head) {
        result += "<thead><tr>\n"
        inTableHead = true
        currentTableColumn = 0
        descendInto(tableHead)
        inTableHead = false
        result += "</tr></thead>\n"
    }

    mutating func visitTableBody(_ tableBody: Table.Body) {
        guard !tableBody.isEmpty else { return }
        result += "<tbody>\n"
        descendInto(tableBody)
        result += "</tbody>\n"
    }

    mutating func visitTableRow(_ tableRow: Table.Row) {
        result += "<tr>\n"
        currentTableColumn = 0
        descendInto(tableRow)
        result += "</tr>\n"
    }

    mutating func visitTableCell(_ tableCell: Table.Cell) {
        guard tableCell.colspan > 0, tableCell.rowspan > 0 else { return }
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        let tag = inTableHead ? "th" : "td"
        var attributes = ""
        if let alignments = tableColumnAlignments, currentTableColumn < alignments.count,
           let alignment = alignments[currentTableColumn] {
            attributes += " align=\"\(MarkdownExportService.escapeAttribute(String(describing: alignment)))\""
        }
        currentTableColumn += 1
        if tableCell.rowspan > 1 {
            attributes += " rowspan=\"\(tableCell.rowspan)\""
        }
        if tableCell.colspan > 1 {
            attributes += " colspan=\"\(tableCell.colspan)\""
        }
        result += "<\(tag)\(attributes)>"
        descendInto(tableCell)
        pendingInlineHTMLTags.removeAll(keepingCapacity: true)
        result += "</\(tag)>\n"
    }

    mutating func visitInlineCode(_ inlineCode: InlineCode) {
        result += "<code>\(MarkdownExportService.escapeText(inlineCode.code))</code>"
    }

    mutating func visitEmphasis(_ emphasis: Emphasis) {
        result += "<em>"
        descendInto(emphasis)
        result += "</em>"
    }

    mutating func visitStrong(_ strong: Strong) {
        result += "<strong>"
        descendInto(strong)
        result += "</strong>"
    }

    mutating func visitImage(_ image: Image) {
        let alt = MarkdownExportService.escapeAttribute(image.plainText)
        var attributes = " alt=\"\(alt)\""
        if let source = image.source,
           let safeSource = SafeURL.imageSource(
               source,
               allowsRemoteImages: allowsRemoteImages
           ) {
            attributes += " src=\"\(MarkdownExportService.escapeAttribute(safeSource))\""
        }
        if let title = image.title, !title.isEmpty {
            attributes += " title=\"\(MarkdownExportService.escapeAttribute(title))\""
        }
        result += "<img\(attributes)>"
    }

    mutating func visitInlineHTML(_ inlineHTML: InlineHTML) {
        let rawHTML = inlineHTML.rawHTML
        let placeholder = Self.rawHTMLPlaceholder(rawHTML)

        if let tag = SafeInlineHTMLTag(opening: rawHTML) {
            pendingInlineHTMLTags.append(PendingInlineHTMLTag(
                tag: tag,
                openerOffset: result.count,
                placeholderLength: placeholder.count
            ))
            result += placeholder
            return
        }

        guard let tag = SafeInlineHTMLTag(closing: rawHTML),
              let pending = pendingInlineHTMLTags.last,
              pending.tag == tag else {
            result += placeholder
            return
        }

        pendingInlineHTMLTags.removeLast()
        let lowerBound = result.index(result.startIndex, offsetBy: pending.openerOffset)
        let upperBound = result.index(lowerBound, offsetBy: pending.placeholderLength)
        result.replaceSubrange(lowerBound..<upperBound, with: tag.openingTag)
        result += tag.closingTag
    }

    private static func rawHTMLPlaceholder(_ rawHTML: String) -> String {
        "<code class=\"raw-html\">\(MarkdownExportService.escapeText(rawHTML))</code>"
    }

    mutating func visitLineBreak(_ lineBreak: LineBreak) {
        result += "<br>\n"
    }

    mutating func visitSoftBreak(_ softBreak: SoftBreak) {
        result += "\n"
    }

    mutating func visitLink(_ link: Link) {
        guard let destination = link.destination, let safeDestination = SafeURL.linkDestination(destination) else {
            descendInto(link)
            return
        }
        result += "<a href=\"\(MarkdownExportService.escapeAttribute(safeDestination))\" rel=\"noreferrer noopener\">"
        descendInto(link)
        result += "</a>"
    }

    mutating func visitText(_ text: Text) {
        result += MarkdownExportService.escapeText(text.string)
    }

    mutating func visitStrikethrough(_ strikethrough: Strikethrough) {
        result += "<del>"
        descendInto(strikethrough)
        result += "</del>"
    }

    mutating func visitSymbolLink(_ symbolLink: SymbolLink) {
        guard let destination = symbolLink.destination else { return }
        result += "<code>\(MarkdownExportService.escapeText(destination))</code>"
    }
}

private enum SafeInlineHTMLTag: String {
    case superscript = "sup"
    case subscriptText = "sub"

    init?(opening rawHTML: String) {
        switch rawHTML {
        case "<sup>": self = .superscript
        case "<sub>": self = .subscriptText
        default: return nil
        }
    }

    init?(closing rawHTML: String) {
        switch rawHTML {
        case "</sup>": self = .superscript
        case "</sub>": self = .subscriptText
        default: return nil
        }
    }

    var openingTag: String { "<\(rawValue)>" }
    var closingTag: String { "</\(rawValue)>" }
}

private struct HeadingSlugger {
    private var occurrences: [String: Int] = [:]

    mutating func slug(for title: String) -> String {
        let folded = title.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        ).lowercased()
        var base = ""
        var pendingSeparator = false

        for character in folded {
            if character.isLetter || character.isNumber || character == "_" {
                if pendingSeparator, !base.isEmpty, !base.hasSuffix("-") {
                    base.append("-")
                }
                base.append(character)
                pendingSeparator = false
            } else if character == "-" || character.isWhitespace {
                pendingSeparator = true
            }
        }

        if base.isEmpty {
            base = "section"
        }
        let occurrence = occurrences[base, default: 0]
        occurrences[base] = occurrence + 1
        return occurrence == 0 ? base : "\(base)-\(occurrence)"
    }
}

private enum SafeURL {
    private static let allowedLinkSchemes: Set<String> = ["http", "https", "mailto", "file"]
    private static let allowedImageSchemes: Set<String> = ["http", "https", "file"]

    static func linkDestination(_ value: String) -> String? {
        validate(value, allowedSchemes: allowedLinkSchemes, allowSafeImageData: false)
    }

    static func imageSource(_ value: String, allowsRemoteImages: Bool) -> String? {
        let schemes = allowsRemoteImages ? allowedImageSchemes : ["file"]
        return validate(value, allowedSchemes: schemes, allowSafeImageData: true)
    }

    private static func validate(
        _ value: String,
        allowedSchemes: Set<String>,
        allowSafeImageData: Bool
    ) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard !trimmed.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else {
            return nil
        }

        let lowercased = trimmed.lowercased()
        if allowSafeImageData, lowercased.hasPrefix("data:image/") {
            let safePrefixes = [
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/gif;base64,",
                "data:image/webp;base64,"
            ]
            return safePrefixes.contains(where: lowercased.hasPrefix) ? trimmed : nil
        }

        if let scheme = URLComponents(string: trimmed)?.scheme?.lowercased(), !scheme.isEmpty {
            return allowedSchemes.contains(scheme) ? trimmed : nil
        }

        return trimmed
    }
}
