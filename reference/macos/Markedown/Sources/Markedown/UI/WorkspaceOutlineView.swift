import AppKit
import SwiftUI

@MainActor
struct WorkspaceOutlineView: NSViewRepresentable {
    let root: WorkspaceNode?
    let activeURL: URL?
    let onOpenFile: (URL) -> Void
    let onExpandDirectory: (WorkspaceNode) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onOpenFile: onOpenFile,
            onExpandDirectory: onExpandDirectory
        )
    }

    func makeNSView(context: Context) -> WorkspaceTreeContainerView {
        let container = WorkspaceTreeContainerView()
        let outlineView = container.outlineView

        outlineView.dataSource = context.coordinator
        outlineView.delegate = context.coordinator
        outlineView.target = context.coordinator
        outlineView.doubleAction = #selector(Coordinator.handleDoubleClick(_:))

        context.coordinator.outlineView = outlineView
        context.coordinator.update(
            root: root,
            activeURL: activeURL,
            onOpenFile: onOpenFile,
            onExpandDirectory: onExpandDirectory
        )
        container.setEmpty(root == nil)
        return container
    }

    func updateNSView(_ container: WorkspaceTreeContainerView, context: Context) {
        context.coordinator.update(
            root: root,
            activeURL: activeURL,
            onOpenFile: onOpenFile,
            onExpandDirectory: onExpandDirectory
        )
        container.setEmpty(root == nil)
    }
}

@MainActor
extension WorkspaceOutlineView {
    @MainActor
    final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        fileprivate weak var outlineView: NSOutlineView?

        private var rootValue: WorkspaceNode?
        private var rootItem: WorkspaceTreeItem?
        private var expandedURLs: Set<URL> = []
        private var activeURL: URL?
        private var onOpenFile: (URL) -> Void
        private var onExpandDirectory: (WorkspaceNode) -> Void
        private var isSynchronizingSelection = false

        init(
            onOpenFile: @escaping (URL) -> Void,
            onExpandDirectory: @escaping (WorkspaceNode) -> Void
        ) {
            self.onOpenFile = onOpenFile
            self.onExpandDirectory = onExpandDirectory
        }

        fileprivate func update(
            root: WorkspaceNode?,
            activeURL: URL?,
            onOpenFile: @escaping (URL) -> Void,
            onExpandDirectory: @escaping (WorkspaceNode) -> Void
        ) {
            self.onOpenFile = onOpenFile
            self.onExpandDirectory = onExpandDirectory
            self.activeURL = activeURL?.standardizedFileURL

            if root != rootValue {
                let rootLocationChanged = root?.url.standardizedFileURL != rootValue?.url.standardizedFileURL
                captureExpandedURLs()
                if rootLocationChanged {
                    expandedURLs.removeAll()
                }
                rootValue = root
                if let root {
                    rootItem = WorkspaceTreeItem(node: root)
                } else {
                    rootItem = nil
                }
                outlineView?.reloadData()
                restoreExpandedItems()
            }

            synchronizeSelection()
        }

        func outlineView(
            _ outlineView: NSOutlineView,
            numberOfChildrenOfItem item: Any?
        ) -> Int {
            if let item = item as? WorkspaceTreeItem {
                return item.children.count
            }
            return rootItem == nil ? 0 : 1
        }

        func outlineView(
            _ outlineView: NSOutlineView,
            child index: Int,
            ofItem item: Any?
        ) -> Any {
            if let item = item as? WorkspaceTreeItem {
                return item.children[index]
            }
            return rootItem!
        }

        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
            guard let item = item as? WorkspaceTreeItem else { return false }
            return item.node.isDirectory
                && (!item.node.hasLoadedChildren || !item.children.isEmpty)
        }

        func outlineView(
            _ outlineView: NSOutlineView,
            viewFor tableColumn: NSTableColumn?,
            item: Any
        ) -> NSView? {
            guard let item = item as? WorkspaceTreeItem else { return nil }

            let cell = outlineView.makeView(
                withIdentifier: WorkspaceTreeCellView.reuseIdentifier,
                owner: nil
            ) as? WorkspaceTreeCellView ?? WorkspaceTreeCellView()

            cell.configure(
                with: item.node,
                isExpanded: outlineView.isItemExpanded(item)
            )
            return cell
        }

        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !isSynchronizingSelection,
                  let outlineView,
                  let item = selectedItem(in: outlineView),
                  !item.node.isDirectory else {
                return
            }
            onOpenFile(item.node.url)
        }

        func outlineViewItemDidExpand(_ notification: Notification) {
            guard let item = notification.userInfo?["NSObject"] as? WorkspaceTreeItem else {
                return
            }
            expandedURLs.insert(item.node.url.standardizedFileURL)
            reloadRow(for: item)
            if !item.node.hasLoadedChildren {
                onExpandDirectory(item.node)
            }
        }

        func outlineViewItemDidCollapse(_ notification: Notification) {
            guard let item = notification.userInfo?["NSObject"] as? WorkspaceTreeItem else {
                return
            }
            expandedURLs.remove(item.node.url.standardizedFileURL)
            reloadRow(for: item)
        }

        @objc fileprivate func handleDoubleClick(_ sender: NSOutlineView) {
            guard let item = selectedItem(in: sender) else { return }

            if item.node.isDirectory {
                if sender.isItemExpanded(item) {
                    sender.collapseItem(item)
                } else {
                    sender.expandItem(item)
                }
            } else {
                onOpenFile(item.node.url)
            }
        }

        private func selectedItem(in outlineView: NSOutlineView) -> WorkspaceTreeItem? {
            guard outlineView.selectedRow >= 0 else { return nil }
            return outlineView.item(atRow: outlineView.selectedRow) as? WorkspaceTreeItem
        }

        private func captureExpandedURLs() {
            guard let outlineView else { return }
            for row in 0..<outlineView.numberOfRows {
                guard let item = outlineView.item(atRow: row) as? WorkspaceTreeItem,
                      outlineView.isItemExpanded(item) else {
                    continue
                }
                expandedURLs.insert(item.node.url.standardizedFileURL)
            }
        }

        private func restoreExpandedItems() {
            guard let outlineView, let rootItem else { return }

            let rootURL = rootItem.node.url.standardizedFileURL
            if expandedURLs.isEmpty || expandedURLs.contains(rootURL) {
                outlineView.expandItem(rootItem)
                expandedURLs.insert(rootURL)
            }

            rootItem.walk { item in
                if expandedURLs.contains(item.node.url.standardizedFileURL) {
                    outlineView.expandItem(item)
                }
            }
        }

        private func synchronizeSelection() {
            guard let outlineView else { return }

            isSynchronizingSelection = true
            defer { isSynchronizingSelection = false }

            guard let activeURL,
                  let item = rootItem?.first(where: {
                      $0.node.url.standardizedFileURL == activeURL
                  }) else {
                outlineView.deselectAll(nil)
                return
            }

            expandAncestors(of: item, in: outlineView)
            let row = outlineView.row(forItem: item)
            guard row >= 0 else { return }

            if outlineView.selectedRow != row {
                outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            }
            outlineView.scrollRowToVisible(row)
        }

        private func expandAncestors(of item: WorkspaceTreeItem, in outlineView: NSOutlineView) {
            var ancestor = item.parent
            while let current = ancestor {
                outlineView.expandItem(current)
                expandedURLs.insert(current.node.url.standardizedFileURL)
                ancestor = current.parent
            }
        }

        private func reloadRow(for item: WorkspaceTreeItem) {
            guard let outlineView else { return }
            let row = outlineView.row(forItem: item)
            guard row >= 0 else { return }
            outlineView.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0))
        }
    }
}

@MainActor
final class WorkspaceTreeContainerView: NSView {
    let outlineView = NSOutlineView()

    private let scrollView = NSScrollView()
    private let emptyLabel = NSTextField(labelWithString: String(
        localized: "sidebar.files.empty",
        defaultValue: "Open a folder to browse files"
    ))

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("workspace-file-name"))
        column.resizingMask = .autoresizingMask
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column
        outlineView.headerView = nil
        outlineView.rowHeight = 26
        outlineView.indentationPerLevel = 13
        outlineView.intercellSpacing = NSSize(width: 0, height: 1)
        outlineView.style = .sourceList
        outlineView.backgroundColor = .clear
        outlineView.focusRingType = .none
        outlineView.allowsMultipleSelection = false
        outlineView.autosaveExpandedItems = false
        outlineView.setAccessibilityIdentifier("workspace-file-tree")
        outlineView.setAccessibilityLabel(String(
            localized: "sidebar.files.accessibility-label",
            defaultValue: "Workspace files"
        ))

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = outlineView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.scrollerStyle = .overlay
        scrollView.setAccessibilityIdentifier("workspace-file-tree-scroll-view")

        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.alignment = .center
        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.maximumNumberOfLines = 2
        emptyLabel.lineBreakMode = .byWordWrapping

        addSubview(scrollView)
        addSubview(emptyLabel)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            emptyLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            emptyLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setEmpty(_ isEmpty: Bool) {
        scrollView.isHidden = isEmpty
        emptyLabel.isHidden = !isEmpty
    }
}

@MainActor
private final class WorkspaceTreeCellView: NSTableCellView {
    static let reuseIdentifier = NSUserInterfaceItemIdentifier("workspace-file-tree-cell")

    private let symbolView = NSImageView()
    private let nameLabel = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        identifier = Self.reuseIdentifier

        symbolView.translatesAutoresizingMaskIntoConstraints = false
        symbolView.imageScaling = .scaleProportionallyDown
        symbolView.contentTintColor = .secondaryLabelColor

        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.font = .systemFont(ofSize: 12.5)
        nameLabel.textColor = .labelColor
        nameLabel.lineBreakMode = .byTruncatingMiddle
        nameLabel.maximumNumberOfLines = 1

        imageView = symbolView
        textField = nameLabel
        addSubview(symbolView)
        addSubview(nameLabel)

        NSLayoutConstraint.activate([
            symbolView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            symbolView.centerYAnchor.constraint(equalTo: centerYAnchor),
            symbolView.widthAnchor.constraint(equalToConstant: 16),
            symbolView.heightAnchor.constraint(equalToConstant: 16),
            nameLabel.leadingAnchor.constraint(equalTo: symbolView.trailingAnchor, constant: 6),
            nameLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            nameLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with node: WorkspaceNode, isExpanded: Bool) {
        nameLabel.stringValue = node.name
        toolTip = node.url.path
        setAccessibilityLabel(node.name)
        setAccessibilityHelp(node.url.path)

        let symbolName: String
        switch node.kind {
        case .directory:
            symbolName = isExpanded ? "folder.fill" : "folder"
        case .markdown:
            symbolName = "doc.richtext"
        case .text:
            symbolName = "doc.plaintext"
        }
        symbolView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
    }
}

private final class WorkspaceTreeItem: NSObject {
    let node: WorkspaceNode
    private(set) weak var parent: WorkspaceTreeItem?
    let children: [WorkspaceTreeItem]

    init(node: WorkspaceNode) {
        self.node = node
        children = node.children?.map(WorkspaceTreeItem.init) ?? []
        super.init()
        children.forEach { $0.parent = self }
    }

    func walk(_ visit: (WorkspaceTreeItem) -> Void) {
        visit(self)
        children.forEach { $0.walk(visit) }
    }

    func first(where predicate: (WorkspaceTreeItem) -> Bool) -> WorkspaceTreeItem? {
        if predicate(self) {
            return self
        }
        for child in children {
            if let match = child.first(where: predicate) {
                return match
            }
        }
        return nil
    }
}
