import AppKit
import Foundation
import MarkdownEngine
import MarkdownEngineLatex
import UniformTypeIdentifiers

@MainActor
final class MarkdownEditorAdapter: NSObject, EditorAdapter {
    let documentID: DocumentID
    private(set) var currentFindResult: EditorFindResult?

    var onModeChange: ((EditorMode) -> Void)?
    var onSelectionChange: ((NSRange, Double) -> Void)?
    var onFindResult: ((EditorFindResult) -> Void)?
    var onImageImportRequiresSave: (() -> Void)?

    private let names: MarkdownEditorBusNames
    private let imageProvider: LocalMarkdownImageProvider
    private let imageAssetStore: MarkdownImageAssetStore
    private let themeState: MarkdownEditorThemeState
    private let syntaxHighlighter: ScopedSyntaxHighlighter
    private let latexRenderer: SwiftMathBridge

    private weak var observedTextView: NSTextView?
    private weak var observedClipView: NSClipView?
    private var isActive = false
    private var typewriterMode = false
    private var typewriterRecenterTask: Task<Void, Never>?
    private var scrollPublishTask: Task<Void, Never>?
    private var mode: EditorMode
    private var source: String
    private var query = ""
    private var findOptions = EditorFindOptions()
    private var currentFindIndex = 0
    private var customFindRanges: [NSRange] = []
    private var lastKnownSelection = NSRange(location: 0, length: 0)
    private var lastKnownScrollOffset = 0.0

    init(
        documentID: DocumentID,
        source: String,
        documentURL: URL?,
        mode: EditorMode,
        themeID: EditorThemeID
    ) {
        self.documentID = documentID
        self.source = source
        self.mode = mode
        names = MarkdownEditorBusNames(documentID: documentID)

        let provider = LocalMarkdownImageProvider()
        imageProvider = provider
        imageAssetStore = MarkdownImageAssetStore(provider: provider, documentURL: documentURL)
        themeState = MarkdownEditorThemeState(themeID: themeID)
        syntaxHighlighter = ScopedSyntaxHighlighter(documentID: documentID, themeID: themeID)
        latexRenderer = SwiftMathBridge()

        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleFindResults(_:)),
            name: names.findResults,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    var selectedRange: NSRange {
        editorTextView()?.selectedRange() ?? lastKnownSelection
    }

    var scrollOffset: Double {
        if let clipView = editorTextView()?.enclosingScrollView?.contentView {
            return Double(clipView.bounds.origin.y)
        }
        return lastKnownScrollOffset
    }

    func synchronize(source: String, documentURL: URL?, mode: EditorMode) {
        self.source = source
        self.mode = mode
        imageAssetStore.update(documentURL: documentURL)
    }

    func configuration(
        themeID: EditorThemeID,
        readingWidth: Double,
        mode: EditorMode,
        typewriterMode: Bool
    ) -> MarkdownEditorConfiguration {
        self.mode = mode
        let typewriterModeChanged = self.typewriterMode != typewriterMode
        self.typewriterMode = typewriterMode
        if typewriterModeChanged, typewriterMode {
            scheduleTypewriterRecenter()
        }
        if themeState.update(themeID: themeID) {
            syntaxHighlighter.update(themeID: themeID)
            syntaxHighlighter.clearCache()
            Task { @MainActor in
                await Task.yield()
                guard let name = syntaxHighlighter.appearanceDidChangeNotification else { return }
                NotificationCenter.default.post(name: name, object: nil)
            }
        }

        let services = MarkdownEditorServices(
            images: imageProvider,
            syntaxHighlighter: syntaxHighlighter,
            latex: latexRenderer,
            bus: names.bus
        )
        var configuration = MarkdownEditorConfiguration(
            theme: themeState.theme,
            services: services,
            textInsets: TextInsets(horizontal: 42, vertical: 44),
            readingWidth: max(CGFloat(readingWidth), 320),
            rawSourceMode: mode == .source,
            extensions: [
                HighlightExtension(),
                StrikethroughExtension(),
            ] + SafeInlineHTMLMarkdownExtensions.all
        )
        configuration.scrollers = .vertical
        configuration.cursorFollowsSpanInk = true

        return configuration
    }

    func activate() {
        isActive = true
        attachToVisibleEditor()
    }

    func deactivate() {
        isActive = false
        typewriterRecenterTask?.cancel()
        typewriterRecenterTask = nil
        scrollPublishTask?.cancel()
        scrollPublishTask = nil
        stopObservingEditor()
    }

    func attachToVisibleEditor() {
        guard isActive, let textView = locateVisibleEditorTextView() else { return }
        observe(textView)
        publishSelection()
    }

    func recordScrollOffset(_ offset: Double) {
        lastKnownScrollOffset = offset
        publishSelection()
    }

    func buildContextMenu(_ menu: NSMenu, selection: NSRange) -> NSMenu {
        lastKnownSelection = selection
        publishSelection()

        if !menu.items.isEmpty {
            menu.addItem(.separator())
        }

        let markdownItem = NSMenuItem(title: String(localized: "Markdown"), action: nil, keyEquivalent: "")
        let markdownMenu = NSMenu(title: String(localized: "Markdown"))
        markdownItem.submenu = markdownMenu
        markdownMenu.addItem(menuItem(String(localized: "Bold"), command: .strong))
        markdownMenu.addItem(menuItem(String(localized: "Italic"), command: .emphasis))
        markdownMenu.addItem(menuItem(String(localized: "Strikethrough"), command: .strikethrough))
        markdownMenu.addItem(menuItem(String(localized: "Highlight"), command: .highlight))
        markdownMenu.addItem(menuItem(String(localized: "Inline Code"), command: .inlineCode))
        markdownMenu.addItem(.separator())

        let headingItem = NSMenuItem(title: String(localized: "Heading"), action: nil, keyEquivalent: "")
        let headingMenu = NSMenu(title: String(localized: "Heading"))
        headingItem.submenu = headingMenu
        headingMenu.addItem(menuItem(String(localized: "Paragraph"), command: .paragraph))
        for level in 1...6 {
            let command = EditorCommand(rawValue: "heading\(level)") ?? .paragraph
            headingMenu.addItem(menuItem(
                localizedFormat("heading-level", level),
                command: command
            ))
        }
        markdownMenu.addItem(headingItem)
        markdownMenu.addItem(menuItem(String(localized: "Block Quote"), command: .blockquote))
        markdownMenu.addItem(menuItem(String(localized: "Task List"), command: .taskList))
        menu.addItem(markdownItem)
        return menu
    }

    func importImages(
        from pasteboard: NSPasteboard,
        completion: @escaping ([String]) -> Void
    ) -> Bool {
        if imageAssetStore.documentURL == nil,
           PasteboardImageReader.canImportImages(from: pasteboard) {
            onImageImportRequiresSave?()
        }
        return imageAssetStore.importImages(from: pasteboard, completion: completion)
    }

    func perform(_ command: EditorCommand) {
        guard isActive else { return }
        switch command {
        case .paragraph:
            applyParagraphStyle()
        case .heading1:
            post(names.applyHeading, userInfo: ["level": 1])
        case .heading2:
            post(names.applyHeading, userInfo: ["level": 2])
        case .heading3:
            post(names.applyHeading, userInfo: ["level": 3])
        case .heading4:
            post(names.applyHeading, userInfo: ["level": 4])
        case .heading5:
            post(names.applyHeading, userInfo: ["level": 5])
        case .heading6:
            post(names.applyHeading, userInfo: ["level": 6])
        case .strong:
            post(names.applyBold)
        case .emphasis:
            post(names.applyItalic)
        case .strikethrough:
            post(names.applyStrikethrough)
        case .highlight:
            post(names.applyHighlight)
        case .inlineCode:
            post(names.applyInlineCode)
        case .link:
            post(names.applyLink, userInfo: ["url": ""])
        case .image:
            chooseAndInsertImage()
        case .blockquote:
            post(names.applyBlockquote)
        case .unorderedList:
            post(names.applyUnorderedList)
        case .orderedList:
            post(names.applyOrderedList)
        case .taskList:
            applyTaskList()
        case .codeBlock:
            post(names.applyCodeBlock)
        case .horizontalRule:
            post(names.applyHorizontalRule)
        case .undo:
            NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
        case .redo:
            NSApp.sendAction(Selector(("redo:")), to: nil, from: nil)
        case .selectAll:
            focusEditor()
            NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
        case .focus:
            focusEditor()
        }
        publishSelection()
    }

    func setMode(_ mode: EditorMode) {
        guard self.mode != mode else { return }
        self.mode = mode
        onModeChange?(mode)
    }

    func find(_ query: String, options: EditorFindOptions) {
        let changed = self.query != query || findOptions != options
        self.query = query
        findOptions = options
        if changed { currentFindIndex = 0 }

        guard !query.isEmpty else {
            clearFind()
            return
        }
        runCurrentFind()
    }

    func findNext() {
        guard !query.isEmpty else { return }
        let count = currentFindResult?.total ?? customFindRanges.count
        if count > 0 {
            currentFindIndex = (currentFindIndex + 1) % count
        }
        runCurrentFind()
    }

    func findPrevious() {
        guard !query.isEmpty else { return }
        let count = currentFindResult?.total ?? customFindRanges.count
        if count > 0 {
            currentFindIndex = (currentFindIndex - 1 + count) % count
        }
        runCurrentFind()
    }

    func clearFind() {
        query = ""
        customFindRanges = []
        currentFindIndex = 0
        currentFindResult = nil
        post(names.findClearHighlights)
    }

    func replaceCurrent(with replacement: String) {
        guard !query.isEmpty else { return }
        if usesEngineFind {
            post(
                names.replaceCurrent,
                userInfo: [
                    "query": query,
                    "replacement": replacement,
                    "currentIndex": currentFindIndex
                ]
            )
            return
        }

        customFindRanges = Self.matches(in: source, query: query, options: findOptions)
        guard !customFindRanges.isEmpty,
              let textView = editorTextView() else {
            publishFindResult(total: 0)
            return
        }
        currentFindIndex = min(currentFindIndex, customFindRanges.count - 1)
        let range = customFindRanges[currentFindIndex]
        textView.insertText(replacement, replacementRange: range)
        source = (source as NSString).replacingCharacters(in: range, with: replacement)
        customFindRanges = Self.matches(in: source, query: query, options: findOptions)
        if !customFindRanges.isEmpty {
            currentFindIndex = min(currentFindIndex, customFindRanges.count - 1)
        } else {
            currentFindIndex = 0
        }
        showCustomFindRanges()
    }

    func replaceAll(query: String, replacement: String, options: EditorFindOptions) {
        self.query = query
        findOptions = options
        currentFindIndex = 0
        guard !query.isEmpty else { return }

        if usesEngineFind {
            post(names.replaceAll, userInfo: ["query": query, "replacement": replacement])
            return
        }

        let ranges = Self.matches(in: source, query: query, options: options)
        guard !ranges.isEmpty, let textView = editorTextView() else {
            publishFindResult(total: 0)
            return
        }
        textView.undoManager?.beginUndoGrouping()
        for range in ranges.reversed() {
            textView.insertText(replacement, replacementRange: range)
        }
        textView.undoManager?.setActionName(String(localized: "Replace All"))
        textView.undoManager?.endUndoGrouping()

        let mutable = NSMutableString(string: source)
        for range in ranges.reversed() {
            mutable.replaceCharacters(in: range, with: replacement)
        }
        source = mutable as String
        customFindRanges = Self.matches(in: source, query: query, options: options)
        showCustomFindRanges()
    }

    func scrollToSourceLocation(_ location: Int) {
        guard let textView = editorTextView() else { return }
        let length = (textView.string as NSString).length
        let safeLocation = min(max(location, 0), length)
        let range = NSRange(location: safeLocation, length: 0)
        textView.setSelectedRange(range)
        post(
            names.findScrollToRange,
            userInfo: [
                "range": range,
                "currentIndex": 0,
                "allRanges": [range]
            ]
        )
        textView.scrollRangeToVisible(range)
        lastKnownSelection = range
        publishSelection()
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            self.post(self.names.findClearHighlights)
        }
    }

    private var usesEngineFind: Bool {
        !findOptions.isCaseSensitive
            && !findOptions.matchesWholeWord
            && !findOptions.usesRegularExpression
    }

    private func runCurrentFind() {
        if usesEngineFind {
            customFindRanges = []
            post(names.findQuery, userInfo: ["query": query, "currentIndex": currentFindIndex])
        } else {
            customFindRanges = Self.matches(in: source, query: query, options: findOptions)
            if !customFindRanges.isEmpty {
                currentFindIndex = min(currentFindIndex, customFindRanges.count - 1)
            } else {
                currentFindIndex = 0
            }
            showCustomFindRanges()
        }
    }

    private func showCustomFindRanges() {
        guard !customFindRanges.isEmpty else {
            post(names.findClearHighlights)
            publishFindResult(total: 0)
            return
        }
        post(
            names.findScrollToRange,
            userInfo: [
                "range": customFindRanges[currentFindIndex],
                "currentIndex": currentFindIndex,
                "allRanges": customFindRanges
            ]
        )
        publishFindResult(total: customFindRanges.count)
    }

    @objc private func handleFindResults(_ notification: Notification) {
        guard let count = notification.userInfo?["count"] as? Int else { return }
        if count > 0 {
            currentFindIndex = min(currentFindIndex, count - 1)
        } else {
            currentFindIndex = 0
        }
        publishFindResult(total: count)
    }

    private func publishFindResult(total: Int) {
        let result = EditorFindResult(
            current: total > 0 ? currentFindIndex + 1 : 0,
            total: total
        )
        currentFindResult = result
        onFindResult?(result)
    }

    private func post(_ name: Notification.Name, userInfo: [AnyHashable: Any]? = nil) {
        NotificationCenter.default.post(name: name, object: nil, userInfo: userInfo)
    }

    private func focusEditor() {
        guard isActive else { return }
        attachToVisibleEditor()
        if let textView = observedTextView ?? locateVisibleEditorTextView() {
            textView.window?.makeFirstResponder(textView)
            observe(textView)
        }
    }

    private func chooseAndInsertImage() {
        guard imageAssetStore.documentURL != nil else {
            onImageImportRequiresSave?()
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.image]
        panel.prompt = String(localized: "Insert")
        guard panel.runModal() == .OK,
              let sourceURL = panel.url,
              let markdown = imageAssetStore.importImage(at: sourceURL),
              let openParen = markdown.lastIndex(of: "("),
              markdown.hasSuffix(")") else { return }
        let pathStart = markdown.index(after: openParen)
        let path = String(markdown[pathStart..<markdown.index(before: markdown.endIndex)])
        post(names.applyImage, userInfo: ["url": path])
    }

    private func applyParagraphStyle() {
        guard let textView = editorTextView() else { return }
        let nsText = textView.string as NSString
        let lineRange = nsText.lineRange(for: textView.selectedRange())
        let line = nsText.substring(with: lineRange)
        guard let match = try? NSRegularExpression(pattern: #"^[ \t]{0,3}#{1,6}[ \t]+"#)
            .firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) else {
            return
        }
        let prefixRange = NSRange(location: lineRange.location + match.range.location, length: match.range.length)
        textView.insertText("", replacementRange: prefixRange)
    }

    private func applyTaskList() {
        guard let textView = editorTextView() else { return }
        let nsText = textView.string as NSString
        let selection = textView.selectedRange()
        let blockRange = nsText.lineRange(for: selection)
        let block = nsText.substring(with: blockRange) as NSString
        if block.length == 0 {
            textView.insertText("- [ ] ", replacementRange: blockRange)
            return
        }
        let lineExpression = try? NSRegularExpression(pattern: #"(?m)^([ \t]*)(?:(?:[-+*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?)?"#)
        let taskExpression = try? NSRegularExpression(pattern: #"^(?:[ \t]*)(?:[-+*]|\d+\.)[ \t]+\[[ xX]\][ \t]+"#)
        guard let lineExpression, let taskExpression else { return }

        let matches = lineExpression.matches(
            in: block as String,
            range: NSRange(location: 0, length: block.length)
        ).filter { $0.range.location < block.length }
        textView.undoManager?.beginUndoGrouping()
        for match in matches.reversed() {
            let fullPrefix = match.range
            let absolutePrefix = NSRange(
                location: blockRange.location + fullPrefix.location,
                length: fullPrefix.length
            )
            let indent = match.range(at: 1).location == NSNotFound
                ? ""
                : block.substring(with: match.range(at: 1))
            let prefix = block.substring(with: fullPrefix)
            let alreadyTask = taskExpression.firstMatch(
                in: prefix,
                range: NSRange(location: 0, length: (prefix as NSString).length)
            ) != nil
            textView.insertText(alreadyTask ? "\(indent)- " : "\(indent)- [ ] ", replacementRange: absolutePrefix)
        }
        textView.undoManager?.setActionName(String(localized: "Task List"))
        textView.undoManager?.endUndoGrouping()
    }

    private func menuItem(_ title: String, command: EditorCommand) -> NSMenuItem {
        let item = NSMenuItem(
            title: title,
            action: #selector(performMenuCommand(_:)),
            keyEquivalent: ""
        )
        item.target = self
        item.representedObject = command.rawValue
        return item
    }

    @objc private func performMenuCommand(_ sender: NSMenuItem) {
        guard let rawValue = sender.representedObject as? String,
              let command = EditorCommand(rawValue: rawValue) else { return }
        perform(command)
    }

    private func editorTextView() -> NSTextView? {
        if let observedTextView,
           observedTextView.window === NSApp.keyWindow,
           Self.isEffectivelyVisible(observedTextView) {
            return observedTextView
        }
        guard isActive, let textView = locateVisibleEditorTextView() else { return nil }
        observe(textView)
        return textView
    }

    private func locateVisibleEditorTextView() -> NSTextView? {
        guard let contentView = NSApp.keyWindow?.contentView else { return nil }
        var stack: [NSView] = [contentView]
        var candidates: [NSTextView] = []
        while let view = stack.popLast() {
            stack.append(contentsOf: view.subviews)
            guard let textView = view as? NSTextView,
                  let delegate = textView.delegate,
                  String(reflecting: type(of: delegate)).contains("NativeTextViewCoordinator"),
                  Self.isEffectivelyVisible(textView) else { continue }
            candidates.append(textView)
        }

        if let firstResponder = NSApp.keyWindow?.firstResponder as? NSTextView,
           candidates.contains(where: { $0 === firstResponder }) {
            return firstResponder
        }
        return candidates.last
    }

    private static func isEffectivelyVisible(_ view: NSView) -> Bool {
        var candidate: NSView? = view
        while let current = candidate {
            if current.isHidden
                || current.alphaValue < 0.01
                || (current.layer?.opacity ?? 1) < 0.01 {
                return false
            }
            candidate = current.superview
        }
        return true
    }

    private func observe(_ textView: NSTextView) {
        guard observedTextView !== textView else { return }
        stopObservingEditor()
        observedTextView = textView
        observedClipView = textView.enclosingScrollView?.contentView
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSelectionChanged(_:)),
            name: NSTextView.didChangeSelectionNotification,
            object: textView
        )
        if let observedClipView {
            observedClipView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleScrollChanged(_:)),
                name: NSView.boundsDidChangeNotification,
                object: observedClipView
            )
        }
    }

    private func stopObservingEditor() {
        if let observedTextView {
            NotificationCenter.default.removeObserver(
                self,
                name: NSTextView.didChangeSelectionNotification,
                object: observedTextView
            )
        }
        if let observedClipView {
            NotificationCenter.default.removeObserver(
                self,
                name: NSView.boundsDidChangeNotification,
                object: observedClipView
            )
        }
        observedTextView = nil
        observedClipView = nil
    }

    @objc private func handleSelectionChanged(_ notification: Notification) {
        publishSelection()
        scheduleTypewriterRecenter()
    }

    @objc private func handleScrollChanged(_ notification: Notification) {
        if let clipView = notification.object as? NSClipView {
            lastKnownScrollOffset = Double(clipView.bounds.origin.y)
        }
        scheduleScrollPublish()
    }

    private func publishSelection() {
        if let textView = observedTextView {
            lastKnownSelection = textView.selectedRange()
            if let clipView = textView.enclosingScrollView?.contentView {
                lastKnownScrollOffset = Double(clipView.bounds.origin.y)
            }
        }
        onSelectionChange?(lastKnownSelection, lastKnownScrollOffset)
    }

    private func scheduleScrollPublish() {
        guard scrollPublishTask == nil else { return }
        scrollPublishTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(160))
            } catch {
                return
            }
            guard let self else { return }
            self.scrollPublishTask = nil
            self.publishSelection()
        }
    }

    private func scheduleTypewriterRecenter() {
        guard typewriterMode, isActive else { return }
        typewriterRecenterTask?.cancel()
        typewriterRecenterTask = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self else { return }
            self.recenterCaret()
            self.typewriterRecenterTask = nil
        }
    }

    private func recenterCaret() {
        guard typewriterMode,
              let textView = editorTextView(),
              let window = textView.window,
              let scrollView = textView.enclosingScrollView,
              let documentView = scrollView.documentView else {
            return
        }

        let selection = textView.selectedRange()
        let caretRange = NSRange(location: selection.location, length: 0)
        let screenRect = textView.firstRect(
            forCharacterRange: caretRange,
            actualRange: nil
        )
        guard !screenRect.isEmpty else { return }

        let windowRect = window.convertFromScreen(screenRect)
        let textRect = textView.convert(windowRect, from: nil)
        let documentRect = documentView.convert(textRect, from: textView)
        let clipView = scrollView.contentView
        var proposedBounds = clipView.bounds
        proposedBounds.origin.y = documentRect.midY - proposedBounds.height / 2
        let constrainedBounds = clipView.constrainBoundsRect(proposedBounds)

        guard abs(constrainedBounds.origin.y - clipView.bounds.origin.y) > 0.5 else {
            return
        }
        clipView.scroll(to: constrainedBounds.origin)
        scrollView.reflectScrolledClipView(clipView)
    }

    private static func matches(
        in source: String,
        query: String,
        options: EditorFindOptions
    ) -> [NSRange] {
        guard !query.isEmpty else { return [] }
        var pattern = options.usesRegularExpression
            ? query
            : NSRegularExpression.escapedPattern(for: query)
        if options.matchesWholeWord {
            pattern = "(?<![\\p{L}\\p{N}_])(?:\(pattern))(?![\\p{L}\\p{N}_])"
        }

        var expressionOptions: NSRegularExpression.Options = []
        if !options.isCaseSensitive {
            expressionOptions.insert(.caseInsensitive)
        }
        guard let expression = try? NSRegularExpression(pattern: pattern, options: expressionOptions) else {
            return []
        }
        let range = NSRange(location: 0, length: (source as NSString).length)
        return expression.matches(in: source, range: range).map(\.range)
    }

}
