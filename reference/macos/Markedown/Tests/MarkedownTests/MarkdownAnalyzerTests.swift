import XCTest
@testable import Markedown

final class MarkdownAnalyzerTests: XCTestCase {
    func testOutlineUsesParsedHeadingsAndStableIdentifiers() throws {
        let source = """
        # First *heading*

        Body text.

        Subheading
        ----------

        ### Third `code`
        """
        let analyzer = MarkdownAnalyzer()

        let first = analyzer.analyze(source)
        let second = analyzer.analyze(source)

        XCTAssertEqual(first.outline.map(\.title), ["First heading", "Subheading", "Third code"])
        XCTAssertEqual(first.outline.map(\.level), [1, 2, 3])
        XCTAssertEqual(first.outline.map(\.id), second.outline.map(\.id))
        XCTAssertEqual(first.outline.count, 3)

        for item in first.outline {
            let range = try XCTUnwrap(item.sourceRange)
            XCTAssertTrue(String(source[range]).contains(item.title.split(separator: " ")[0]))
        }
    }

    func testStatisticsCountVisibleWordsAndCJKCharacters() {
        let source = """
        # Hello 世界
        Swift isn't slow.

        `code value`
        """
        let statistics = MarkdownAnalyzer(readingWordsPerMinute: 4).statistics(for: source)

        XCTAssertEqual(statistics.wordCount, 8)
        XCTAssertEqual(statistics.characterCount, source.count)
        XCTAssertEqual(
            statistics.characterCountExcludingWhitespace,
            source.filter { !$0.isWhitespace }.count
        )
        XCTAssertEqual(statistics.lineCount, 4)
        XCTAssertEqual(statistics.estimatedReadingTime, 120, accuracy: 0.001)
        XCTAssertEqual(statistics.estimatedReadingMinutes, 2)
    }

    func testEmptyDocumentStatisticsAreZero() {
        let statistics = MarkdownAnalyzer().statistics(for: "")

        XCTAssertEqual(statistics.wordCount, 0)
        XCTAssertEqual(statistics.characterCount, 0)
        XCTAssertEqual(statistics.lineCount, 0)
        XCTAssertEqual(statistics.estimatedReadingTime, 0)
        XCTAssertEqual(statistics.estimatedReadingMinutes, 0)
    }

    func testHTMLExportEscapesRawHTMLAndBuildsStableHeadingAnchors() {
        let markdown = """
        <script>alert('unsafe')</script>

        # Hello World

        # Hello World

        <img src=x onerror=alert(1)>

        [unsafe link](javascript:alert(1))
        """
        let exported = MarkdownExportService().makeHTMLDocument(
            markdown: markdown,
            title: "A <title>",
            includeStyles: true,
            theme: .graphite
        )

        XCTAssertTrue(exported.html.contains("Content-Security-Policy"))
        XCTAssertTrue(exported.html.contains("sup, sub { font-size: 72%; line-height: 0; }"))
        XCTAssertTrue(exported.html.contains("script-src 'none'"))
        XCTAssertTrue(exported.html.contains("&lt;script&gt;"))
        XCTAssertFalse(exported.html.contains("<script>"))
        XCTAssertTrue(exported.html.contains("&lt;img src=x onerror=alert(1)&gt;"))
        XCTAssertFalse(exported.html.contains("<img src=x onerror="))
        XCTAssertFalse(exported.html.contains("href=\"javascript:"))
        XCTAssertTrue(exported.html.contains("<title>A &lt;title&gt;</title>"))
        XCTAssertTrue(exported.html.contains("id=\"hello-world\""))
        XCTAssertTrue(exported.html.contains("id=\"hello-world-1\""))
        XCTAssertEqual(exported.headings.map(\.anchor), ["hello-world", "hello-world-1"])
        XCTAssertEqual(String(decoding: exported.data, as: UTF8.self), exported.html)
    }

    func testHTMLExportRendersOnlyBalancedExactSuperscriptAndSubscriptTags() {
        let exported = MarkdownExportService().makeHTMLDocument(
            markdown: "H<sub>2 & **O**</sub> and x<sup>2</sup>",
            includeStyles: false,
            theme: .system,
            includeOutline: false
        )

        XCTAssertTrue(exported.bodyHTML.contains(
            "<p>H<sub>2 &amp; <strong>O</strong></sub> and x<sup>2</sup></p>"
        ))

        let escapedAsterisk = MarkdownExportService().makeHTMLDocument(
            markdown: #"*Xiao He<sup>1,3,4\*</sup>*"#,
            includeStyles: false,
            theme: .system,
            includeOutline: false
        )
        XCTAssertTrue(escapedAsterisk.bodyHTML.contains(
            "<p><em>Xiao He<sup>1,3,4*</sup></em></p>"
        ))
    }

    func testHTMLExportEscapesUnsafeAndUnbalancedInlineHTML() {
        let markdown = """
        unsafe <sup onclick="alert(1)">x</sup> <SUP>y</SUP> <sub />

        unmatched <sup>open

        unmatched close </sup>

        inline <script>alert('unsafe')</script> text
        """
        let exported = MarkdownExportService().makeHTMLDocument(
            markdown: markdown,
            includeStyles: false,
            theme: .system,
            includeOutline: false
        )

        XCTAssertFalse(exported.bodyHTML.contains("<sup onclick="))
        XCTAssertFalse(exported.bodyHTML.contains("<SUP>"))
        XCTAssertFalse(exported.bodyHTML.contains("<script>"))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;sup onclick="))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;SUP&gt;"))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;sub /&gt;"))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;sup&gt;"))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;/sup&gt;"))
        XCTAssertTrue(exported.bodyHTML.contains("&lt;script&gt;"))
    }

    func testUnstyledHTMLDoesNotContainStyleElement() {
        let data = MarkdownExportService().makeUnstyledHTMLData(
            markdown: "# Heading",
            includeOutline: false
        )
        let html = String(decoding: data, as: UTF8.self)

        XCTAssertFalse(html.contains("<style>"))
        XCTAssertFalse(html.contains("document-outline"))
        XCTAssertTrue(html.contains("<h1 id=\"heading\">Heading</h1>"))
    }

    func testHTMLExportBlocksRemoteImagesByDefault() {
        let service = MarkdownExportService()
        let blockedHTML = service.makeHTMLDocument(
            markdown: "![tracking](https://example.com/pixel.png)",
            options: ExportOptions()
        ).html

        var permittedOptions = ExportOptions()
        permittedOptions.allowsRemoteImages = true
        let permittedHTML = service.makeHTMLDocument(
            markdown: "![tracking](https://example.com/pixel.png)",
            options: permittedOptions
        ).html

        XCTAssertFalse(blockedHTML.contains("src=\"https://example.com/pixel.png\""))
        XCTAssertFalse(blockedHTML.contains("img-src data: file: https:"))
        XCTAssertTrue(permittedHTML.contains("src=\"https://example.com/pixel.png\""))
        XCTAssertTrue(permittedHTML.contains("img-src data: file: https: http:"))
    }

    func testPandocCommandUsesArgumentArrayWithoutShell() throws {
        let adapter = PandocCommandAdapter(
            executableURL: URL(fileURLWithPath: "/opt/local/bin/pandoc")
        )
        let inputURL = URL(fileURLWithPath: "/tmp/input;touch-owned.md")
        let outputURL = URL(fileURLWithPath: "/tmp/output document.docx")
        var options = ExportOptions()
        options.includeOutline = true

        let command = try adapter.command(
            inputURL: inputURL,
            outputURL: outputURL,
            format: .docx,
            options: options
        )

        XCTAssertEqual(command.executableURL.path, "/opt/local/bin/pandoc")
        XCTAssertEqual(command.arguments.last, inputURL.path)
        XCTAssertTrue(command.arguments.contains(outputURL.path))
        XCTAssertTrue(command.arguments.contains("--toc"))
        XCTAssertFalse(command.arguments.contains("-c"))
        XCTAssertEqual(command.arguments.filter { $0 == inputURL.path }.count, 1)
    }

    func testPDFAndImageRequestsReuseSafeHTMLData() throws {
        let service = MarkdownExportService()
        var options = ExportOptions()
        options.pageSize = "Letter"

        let pdf = try service.makeRenderRequest(
            markdown: "# Report",
            format: .pdf,
            options: options
        )
        let image = try service.makeRenderRequest(
            markdown: "# Report",
            format: .image,
            options: options
        )

        XCTAssertEqual(pdf.target, .pdf)
        XCTAssertEqual(image.target, .image)
        XCTAssertEqual(pdf.pageSize, "Letter")
        XCTAssertTrue(String(decoding: pdf.htmlData, as: UTF8.self).contains("script-src 'none'"))
    }

    func testPandocRejectsBuiltInHTMLFormat() {
        let adapter = PandocCommandAdapter()

        XCTAssertThrowsError(
            try adapter.command(
                inputURL: URL(fileURLWithPath: "/tmp/input.md"),
                outputURL: URL(fileURLWithPath: "/tmp/output.html"),
                format: .html
            )
        ) { error in
            XCTAssertEqual(error as? PandocExportError, .unsupportedFormat(.html))
        }
    }
}
