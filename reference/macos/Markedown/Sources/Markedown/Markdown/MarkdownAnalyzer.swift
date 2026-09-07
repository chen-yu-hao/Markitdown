import Foundation
import Markdown

struct MarkdownStatistics: Hashable, Codable, Sendable {
    let wordCount: Int
    let characterCount: Int
    let characterCountExcludingWhitespace: Int
    let lineCount: Int
    let estimatedReadingTime: TimeInterval

    var estimatedReadingMinutes: Int {
        guard estimatedReadingTime > 0 else { return 0 }
        return max(1, Int(ceil(estimatedReadingTime / 60)))
    }
}

struct MarkdownAnalysis: Hashable, Sendable {
    let outline: [OutlineItem]
    let statistics: MarkdownStatistics
}

struct MarkdownAnalyzer: Sendable {
    let readingWordsPerMinute: Int

    init(readingWordsPerMinute: Int = 200) {
        self.readingWordsPerMinute = max(1, readingWordsPerMinute)
    }

    func analyze(_ source: String) -> MarkdownAnalysis {
        let document = Document(parsing: source)
        let indexConverter = SourceIndexConverter(source: source)
        let outline = makeOutline(
            from: document,
            indexConverter: indexConverter
        )

        var collector = VisibleTextCollector()
        collector.visit(document)

        let words = Self.countWords(in: collector.text)
        let readingTime = words == 0
            ? 0
            : (Double(words) / Double(readingWordsPerMinute)) * 60

        return MarkdownAnalysis(
            outline: outline,
            statistics: MarkdownStatistics(
                wordCount: words,
                characterCount: source.count,
                characterCountExcludingWhitespace: source.lazy.filter { !$0.isWhitespace }.count,
                lineCount: Self.countLines(in: source),
                estimatedReadingTime: readingTime
            )
        )
    }

    func outline(for source: String) -> [OutlineItem] {
        analyze(source).outline
    }

    func statistics(for source: String) -> MarkdownStatistics {
        analyze(source).statistics
    }

    private func makeOutline(
        from document: Document,
        indexConverter: SourceIndexConverter
    ) -> [OutlineItem] {
        var result: [OutlineItem] = []

        func visit(_ markup: Markup) {
            if let heading = markup as? Heading {
                var titleCollector = VisibleTextCollector()
                titleCollector.visit(heading)
                let title = titleCollector.text.trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                let sourceRange = heading.range.flatMap(indexConverter.range(for:))
                let location = heading.range?.lowerBound
                let seed = [
                    String(heading.level),
                    String(location?.line ?? 0),
                    String(location?.column ?? 0),
                    title
                ].joined(separator: "\u{1F}")

                result.append(
                    OutlineItem(
                        id: StableUUID.make(seed: seed),
                        title: title,
                        level: heading.level,
                        sourceRange: sourceRange
                    )
                )
            }

            for child in markup.children {
                visit(child)
            }
        }

        visit(document)
        return result
    }

    private static func countLines(in source: String) -> Int {
        guard !source.isEmpty else { return 0 }
        return source.utf8.reduce(into: 1) { count, byte in
            if byte == 0x0A {
                count += 1
            }
        }
    }

    private static func countWords(in text: String) -> Int {
        var count = 0
        var isInsideWord = false

        for character in text {
            if character.isCJKWordCharacter {
                count += 1
                isInsideWord = false
            } else if character.isLetter || character.isNumber {
                if !isInsideWord {
                    count += 1
                    isInsideWord = true
                }
            } else if (character == "'" || character == "\u{2019}") && isInsideWord {
                continue
            } else {
                isInsideWord = false
            }
        }

        return count
    }
}

private struct VisibleTextCollector: MarkupWalker {
    private(set) var text = ""

    mutating func visitHeading(_ heading: Heading) {
        appendBoundary()
        descendInto(heading)
        appendBoundary()
    }

    mutating func visitParagraph(_ paragraph: Paragraph) {
        appendBoundary()
        descendInto(paragraph)
        appendBoundary()
    }

    mutating func visitListItem(_ listItem: ListItem) {
        appendBoundary()
        descendInto(listItem)
        appendBoundary()
    }

    mutating func visitTableCell(_ tableCell: Table.Cell) {
        appendBoundary()
        descendInto(tableCell)
        appendBoundary()
    }

    mutating func visitText(_ textNode: Text) {
        text += textNode.string
    }

    mutating func visitInlineCode(_ inlineCode: InlineCode) {
        appendSeparated(inlineCode.code)
    }

    mutating func visitCodeBlock(_ codeBlock: CodeBlock) {
        appendSeparated(codeBlock.code)
    }

    mutating func visitImage(_ image: Image) {
        appendSeparated(image.plainText)
    }

    mutating func visitSoftBreak(_ softBreak: SoftBreak) {
        text.append("\n")
    }

    mutating func visitLineBreak(_ lineBreak: LineBreak) {
        text.append("\n")
    }

    mutating func visitHTMLBlock(_ html: HTMLBlock) {
        // Raw HTML is syntax, not visible prose, unless a renderer explicitly opts in.
    }

    mutating func visitInlineHTML(_ inlineHTML: InlineHTML) {
        // Keep statistics independent from potentially executable HTML fragments.
    }

    private mutating func appendSeparated(_ value: String) {
        guard !value.isEmpty else { return }
        if let last = text.last, !last.isWhitespace {
            text.append(" ")
        }
        text += value
        text.append(" ")
    }

    private mutating func appendBoundary() {
        guard let last = text.last, !last.isWhitespace else { return }
        text.append(" ")
    }
}

private struct SourceIndexConverter: Sendable {
    let source: String
    let lineStartUTF8Offsets: [Int]

    init(source: String) {
        self.source = source
        var offsets = [0]
        for (offset, byte) in source.utf8.enumerated() where byte == 0x0A {
            offsets.append(offset + 1)
        }
        lineStartUTF8Offsets = offsets
    }

    func range(for sourceRange: SourceRange) -> Range<String.Index>? {
        guard
            let lowerBound = index(for: sourceRange.lowerBound),
            let upperBound = index(for: sourceRange.upperBound),
            lowerBound <= upperBound
        else {
            return nil
        }
        return lowerBound..<upperBound
    }

    private func index(for location: SourceLocation) -> String.Index? {
        let lineIndex = location.line - 1
        guard lineStartUTF8Offsets.indices.contains(lineIndex), location.column > 0 else {
            return nil
        }

        let offset = lineStartUTF8Offsets[lineIndex] + location.column - 1
        guard offset >= 0, offset <= source.utf8.count else { return nil }
        let utf8Index = source.utf8.index(source.utf8.startIndex, offsetBy: offset)
        return String.Index(utf8Index, within: source)
    }
}

private enum StableUUID {
    static func make(seed: String) -> UUID {
        var first: UInt64 = 0xCBF29CE484222325
        var second: UInt64 = 0x9E3779B97F4A7C15

        for byte in seed.utf8 {
            first ^= UInt64(byte)
            first &*= 0x100000001B3
            second ^= UInt64(byte) &+ 0x9D
            second = (second &* 0x100000001B3).rotatedLeft(by: 13)
        }

        var bytes = withUnsafeBytes(of: first.bigEndian, Array.init)
        bytes += withUnsafeBytes(of: second.bigEndian, Array.init)
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80

        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}

private extension UInt64 {
    func rotatedLeft(by amount: UInt64) -> UInt64 {
        (self << amount) | (self >> (64 - amount))
    }
}

private extension Character {
    var isCJKWordCharacter: Bool {
        unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3400...0x4DBF,
                 0x4E00...0x9FFF,
                 0xF900...0xFAFF,
                 0x20000...0x2EBEF,
                 0x3040...0x30FF,
                 0x31F0...0x31FF,
                 0xAC00...0xD7AF:
                true
            default:
                false
            }
        }
    }
}
