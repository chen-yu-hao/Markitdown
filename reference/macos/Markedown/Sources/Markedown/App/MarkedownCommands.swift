import AppKit
import SwiftUI

@MainActor
struct MarkedownCommands: Commands {
    @FocusedValue(\.markedownController) private var controller
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        ActiveMarkedownCommands(
            controller: controller,
            openWorkspaceWindow: { openWindow(id: "workspace") }
        )
    }
}

@MainActor
private struct ActiveMarkedownCommands: Commands {
    let controller: AppController?
    let openWorkspaceWindow: () -> Void

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Document") {
                if let controller {
                    controller.newDocument()
                } else {
                    openWorkspaceWindow()
                }
            }
            .keyboardShortcut("n", modifiers: .command)

            Button("Open File...") {
                controller?.chooseFilesToOpen()
            }
            .keyboardShortcut("o", modifiers: .command)
            .disabled(controller == nil)

            Button("Open Folder...") {
                controller?.chooseFolderToOpen()
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            .disabled(controller == nil)
        }

        CommandGroup(after: .newItem) {
            Divider()

            Button("Save") {
                controller?.saveActiveDocumentFromMenu()
            }
            .keyboardShortcut("s", modifiers: .command)
            .disabled(controller?.activeDocument == nil)

            Button("Save As...") {
                controller?.saveActiveDocumentAs()
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])
            .disabled(controller?.activeDocument == nil)

            Menu("Export") {
                Button("HTML...") {
                    controller?.exportHTML()
                }
                Button("PDF...") {
                    controller?.exportRendered(.pdf)
                }
                Button("Long Image...") {
                    controller?.exportRendered(.image)
                }
                Divider()
                Button("DOCX with Pandoc...") {
                    controller?.exportWithPandoc(.docx)
                }
                Button("EPUB with Pandoc...") {
                    controller?.exportWithPandoc(.epub)
                }
                Button("LaTeX with Pandoc...") {
                    controller?.exportWithPandoc(.latex)
                }
                Button("RTF with Pandoc...") {
                    controller?.exportWithPandoc(.rtf)
                }
                Button("ODT with Pandoc...") {
                    controller?.exportWithPandoc(.odt)
                }
            }
            .disabled(controller?.activeDocument == nil || controller?.isExporting == true)

            Divider()

            Button(controller == nil
                ? String(localized: "Close Window")
                : String(localized: "Close Document")) {
                if let controller {
                    controller.closeActiveDocument()
                } else {
                    NSApp.keyWindow?.performClose(nil)
                }
            }
            .keyboardShortcut("w", modifiers: .command)
            .disabled(controller != nil && controller?.activeDocument == nil)
        }

        CommandGroup(replacing: .undoRedo) {
            Button("Undo") {
                controller?.commandCenter.perform(.undo)
            }
            .keyboardShortcut("z", modifiers: .command)
            .disabled(controller == nil)
            Button("Redo") {
                controller?.commandCenter.perform(.redo)
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
            .disabled(controller == nil)
        }

        CommandGroup(after: .pasteboard) {
            Button("Find...") {
                controller?.showFind()
            }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(controller?.activeDocument == nil)
        }

        CommandMenu("Format") {
            Button("Bold") {
                controller?.commandCenter.perform(.strong)
            }
            .keyboardShortcut("b", modifiers: .command)
            .disabled(controller?.activeDocument == nil)

            Button("Italic") {
                controller?.commandCenter.perform(.emphasis)
            }
            .keyboardShortcut("i", modifiers: .command)
            .disabled(controller?.activeDocument == nil)

            Button("Strikethrough") {
                controller?.commandCenter.perform(.strikethrough)
            }
            .keyboardShortcut("x", modifiers: [.command, .shift])
            .disabled(controller?.activeDocument == nil)

            Button("Highlight") {
                controller?.commandCenter.perform(.highlight)
            }
            .keyboardShortcut("h", modifiers: [.command, .shift])
            .disabled(controller?.activeDocument == nil)

            Divider()

            Button("Inline Code") {
                controller?.commandCenter.perform(.inlineCode)
            }
            .keyboardShortcut("`", modifiers: .command)
            .disabled(controller?.activeDocument == nil)

            Button("Link") {
                controller?.commandCenter.perform(.link)
            }
            .keyboardShortcut("k", modifiers: .command)
            .disabled(controller?.activeDocument == nil)

            Divider()

            Button("Bullet List") {
                controller?.commandCenter.perform(.unorderedList)
            }
            .disabled(controller?.activeDocument == nil)
            Button("Numbered List") {
                controller?.commandCenter.perform(.orderedList)
            }
            .disabled(controller?.activeDocument == nil)
            Button("Task List") {
                controller?.commandCenter.perform(.taskList)
            }
            .disabled(controller?.activeDocument == nil)
            Button("Block Quote") {
                controller?.commandCenter.perform(.blockquote)
            }
            .disabled(controller?.activeDocument == nil)
            Button("Code Block") {
                controller?.commandCenter.perform(.codeBlock)
            }
            .disabled(controller?.activeDocument == nil)
        }

        CommandGroup(after: .sidebar) {
            Divider()
            Button(controller?.workspaceSession.isSidebarVisible == true
                ? String(localized: "Hide Sidebar")
                : String(localized: "Show Sidebar")) {
                controller?.toggleSidebar()
            }
            .keyboardShortcut("s", modifiers: [.command, .control])
            .disabled(controller == nil)

            Button(controller?.workspaceSession.isToolbarVisible == true
                ? String(localized: "Hide Format Bar")
                : String(localized: "Show Format Bar")) {
                controller?.toggleFormattingToolbar()
            }
            .disabled(controller == nil)

            Divider()

            Button("Live Preview") {
                controller?.setEditorMode(.live)
            }
            .keyboardShortcut("/", modifiers: [.command, .option])
            .disabled(controller?.activeDocument == nil || controller?.activeDocument?.editorMode == .live)

            Button("Source Mode") {
                controller?.setEditorMode(.source)
            }
            .keyboardShortcut("/", modifiers: .command)
            .disabled(controller?.activeDocument == nil || controller?.activeDocument?.editorMode == .source)

            Divider()

            Button(controller?.workspaceSession.isFocusMode == true
                ? String(localized: "Exit Focus Mode")
                : String(localized: "Focus Mode")) {
                controller?.toggleFocusMode()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(controller?.activeDocument == nil)

            Button(controller?.workspaceSession.isTypewriterMode == true
                ? String(localized: "Exit Typewriter Mode")
                : String(localized: "Typewriter Mode")) {
                controller?.toggleTypewriterMode()
            }
            .keyboardShortcut("t", modifiers: [.command, .shift])
            .disabled(controller?.activeDocument == nil)
        }
    }
}
