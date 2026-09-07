import AppKit
import MarkdownEngine
import XCTest
@testable import Markedown

final class SafeInlineHTMLFormattingTests: XCTestCase {
    func testExtensionsUseExactSafeTagsAndNativeSuperscriptAttributes() throws {
        let superscript = SuperscriptMarkdownExtension()
        let subscriptExtension = SubscriptMarkdownExtension()

        XCTAssertEqual(
            superscript.inline,
            InlineSyntax(open: "<sup>", close: "</sup>")
        )
        XCTAssertEqual(
            subscriptExtension.inline,
            InlineSyntax(open: "<sub>", close: "</sub>")
        )
        XCTAssertEqual(
            superscript.contentAttributes(theme: .default)[.superscript] as? Int,
            1
        )
        XCTAssertEqual(
            subscriptExtension.contentAttributes(theme: .default)[.superscript] as? Int,
            -1
        )
        XCTAssertEqual(
            superscript.relativeContentFontScale,
            SafeInlineHTMLMarkdownExtensions.relativeFontScale
        )
        XCTAssertEqual(
            subscriptExtension.relativeContentFontScale,
            SafeInlineHTMLMarkdownExtensions.relativeFontScale
        )
    }

    func testEditorCleanCopyRendersSafeTagsAndNestedMarkdown() {
        let extensions = SafeInlineHTMLMarkdownExtensions.all
        let html = MarkdownHTMLRenderer.html(
            from: "H<sub>2</sub>O and x<sup>**2**</sup>",
            extensions: extensions
        )

        XCTAssertEqual(
            html,
            "<p>H<sub>2</sub>O and x<sup><strong>2</strong></sup></p>"
        )
        XCTAssertEqual(
            MarkdownHTMLRenderer.html(
                from: "**Yuhao Chen<sup>1</sup>,** **Dayou Zhang<sup>2</sup>**",
                extensions: extensions
            ),
            "<p><strong>Yuhao Chen<sup>1</sup>,</strong> <strong>Dayou Zhang<sup>2</sup></strong></p>"
        )
        XCTAssertEqual(
            MarkdownHTMLRenderer.html(
                from: #"*Xiao He<sup>1,3,4\*</sup>*"#,
                extensions: extensions
            ),
            "<p><em>Xiao He<sup>1,3,4*</sup></em></p>"
        )
        XCTAssertEqual(
            MarkdownHTMLRenderer.html(
                from: #"*Yuhao Chen<sup>1</sup>,* *Dayou Zhang<sup>2</sup>, Donald G. Truhlar<sup>2</sup>, Xiao He<sup>1,3,4\*</sup>*"#,
                extensions: extensions
            ),
            "<p><em>Yuhao Chen<sup>1</sup>,</em> <em>Dayou Zhang<sup>2</sup>, Donald G. Truhlar<sup>2</sup>, Xiao He<sup>1,3,4*</sup></em></p>"
        )
    }

    func testEditorLeavesUnsafeOrIncompleteTagsLiteral() {
        let extensions = SafeInlineHTMLMarkdownExtensions.all

        XCTAssertEqual(
            MarkdownHTMLRenderer.html(
                from: "<sup onclick=\"alert(1)\">x</sup>",
                extensions: extensions
            ),
            "<p>&lt;sup onclick=&quot;alert(1)&quot;&gt;x&lt;/sup&gt;</p>"
        )
        XCTAssertEqual(
            MarkdownHTMLRenderer.html(from: "<SUP>x</SUP>", extensions: extensions),
            "<p>&lt;SUP&gt;x&lt;/SUP&gt;</p>"
        )
        XCTAssertEqual(
            MarkdownHTMLRenderer.html(from: "open <sub>x", extensions: extensions),
            "<p>open &lt;sub&gt;x</p>"
        )
    }
}
