# Dependency Provenance

These directories originate from GitHub codeload tag archives. The two
`Package.swift` files replace remote package URLs with neighboring paths so the
application stays reproducible when GitHub's Git smart HTTP endpoint is
unavailable. Markedown also carries small Apache-2.0 editor-engine patches,
listed below.

| Package | Version | Upstream revision | Archive SHA-256 |
| --- | --- | --- | --- |
| swift-markdown-engine | 0.12.0 | `e5f7607fc4021181056ef7a09dbb7573dc0237d9` | `1aa57c3d34133911f40cb9a8d5fff482f848d9972ff0aff96996067f0130781e` |
| swift-markdown | 0.8.0 | `3c6f9523da3a1ec2fd829673e472d95b8097a3b8` | `9bf5066d7d8209c07153902e63bbb91ece5d71350e2eaa2a765817fa85bc8d9e` |
| swift-cmark | 0.8.0 | `924936d0427cb25a61169739a7660230bffa6ea6` | `4c068eceff617a336690b3e70f6c79a81d56f3ee09b67cc65cac0f39f6507f35` |
| HighlighterSwift | 3.1.0 | `fe7aae9c9b31d3b296fd3d2dd575e1a207bb29e0` | `81f2fcd1d1be378f8a93b5bb8db2e61d5e34b515e1612506a838eedad0ea2739` |
| SwiftMath | 1.7.3 | `fa8244ed032f4a1ade4cb0571bf87d2f1a9fd2d7` | `a2b2c09a7835a9ddc756f9ab52ea8c019a8bb531e13e2d88ac0ad4e69f75eea3` |

The original license files remain inside each package directory.

## Markedown-local patch

- `swift-markdown-engine 0.12.0`: the clip-view scroll callback coalesces
  TextKit viewport layout instead of forcing a document-head layout walk for
  every bounds change. Full layout settling after real restyles is unchanged.
  Modified files: `NativeTextView.swift`,
  `NativeTextView+FrameAndOverscroll.swift`, and `NativeTextViewWrapper.swift`.
  The changes remain under Apache License 2.0.
- `swift-markdown-engine 0.12.0`: recursively parsed extensions accept already
  claimed inline spans only when they are fully contained by the extension's
  content range, so escaped punctuation remains valid inside safe `<sup>` and
  `<sub>` spans without allowing marker-boundary crossings. Extensions may also
  request a relative content-font scale derived from the inherited font; this
  preserves family, size context, and bold/italic traits in body text and table
  cells. Modified files: `MarkdownExtension.swift`, `InlineParser.swift`,
  `MarkdownASTStyler.swift`, and `MarkdownStyler+Tables.swift`. The changes
  remain under Apache License 2.0.
- `swift-markdown-engine 0.12.0`: image paste and drag handling accepts an
  ordered batch, supports AppKit file promises used by Photos, and inserts the
  resulting Markdown in one undo transaction. Pasteboard validation is
  metadata-only so it does not decode images while menus are updated. Modified
  files: `PasteboardImageReader.swift`, `NativeTextView.swift`,
  `NativeTextViewWrapper.swift`, `NativeTextView+PasteHandling.swift`, and
  `NativeTextView+ImageDrop.swift`. The changes remain under Apache License
  2.0.
