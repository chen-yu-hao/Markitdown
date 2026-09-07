import SwiftUI

struct SettingsView: View {
    @Bindable var settings: AppSettings

    var body: some View {
        TabView {
            GeneralSettingsPane(settings: settings)
                .tabItem { Label("General", systemImage: "gearshape") }

            AppearanceSettingsPane(settings: settings)
                .tabItem { Label("Appearance", systemImage: "circle.lefthalf.filled") }

            EditorSettingsPane(settings: settings)
                .tabItem { Label("Editor", systemImage: "text.cursor") }

            MarkdownSettingsPane()
                .tabItem { Label("Markdown", systemImage: "text.document") }

            ExportSettingsPane(settings: settings)
                .tabItem { Label("Export", systemImage: "square.and.arrow.up") }
        }
        .frame(width: 560, height: 430)
        .padding(.top, 8)
    }
}

private struct GeneralSettingsPane: View {
    @Bindable var settings: AppSettings

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Reopen the last workspace", isOn: $settings.rememberWorkspace)
            }

            Section("Documents") {
                Toggle("Save changes automatically", isOn: $settings.autoSave)
            }
        }
        .formStyle(.grouped)
        .padding(12)
    }
}

private struct AppearanceSettingsPane: View {
    @Bindable var settings: AppSettings

    var body: some View {
        Form {
            Section("Theme") {
                Picker("Color theme", selection: $settings.themeID) {
                    ForEach(AppSettings.themes) { theme in
                        Text(theme.displayName).tag(theme.id)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Reading") {
                LabeledContent("Text size") {
                    HStack(spacing: 10) {
                        Slider(value: $settings.editorFontSize, in: 13...24, step: 1)
                            .frame(width: 220)
                        Text("\(Int(settings.editorFontSize)) pt")
                            .monospacedDigit()
                            .frame(width: 44, alignment: .trailing)
                    }
                }

                LabeledContent("Reading width") {
                    HStack(spacing: 10) {
                        Slider(value: $settings.readingWidth, in: 560...960, step: 20)
                            .frame(width: 220)
                        Text("\(Int(settings.readingWidth)) px")
                            .monospacedDigit()
                            .frame(width: 52, alignment: .trailing)
                    }
                }
            }

            Section("Chrome") {
                Toggle("Show formatting toolbar", isOn: $settings.showToolbar)
                Toggle("Show document status", isOn: $settings.showStatusBar)
            }
        }
        .formStyle(.grouped)
        .padding(12)
    }
}

private struct EditorSettingsPane: View {
    @Bindable var settings: AppSettings

    var body: some View {
        Form {
            Section("Privacy") {
                Toggle("Include remote images in HTML exports", isOn: $settings.loadRemoteImages)
                Text("The editor and rendered export preview never load remote images.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(12)
    }
}

private struct MarkdownSettingsPane: View {
    var body: some View {
        Form {
            Section("Dialect") {
                LabeledContent("Parser", value: "CommonMark + GFM")
                LabeledContent(
                    "Inline extensions",
                    value: "Strikethrough, highlight, superscript and subscript"
                )
                LabeledContent("Math", value: "Inline and display LaTeX")
            }

            Section("Safety") {
                LabeledContent("Other raw HTML", value: "Preserve as source")
                Text("Only exact <sup> and <sub> tags are formatted. Scripts and embedded HTML are never executed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(12)
    }
}

private struct ExportSettingsPane: View {
    @Bindable var settings: AppSettings

    var body: some View {
        Form {
            Section("PDF") {
                Picker("Paper size", selection: $settings.exportPageSize) {
                    Text("A4").tag("A4")
                    Text("US Letter").tag("Letter")
                }
                Toggle("Include document outline", isOn: $settings.exportIncludesOutline)
            }

            Section("Additional formats") {
                LabeledContent("Pandoc", value: "Detected when exporting")
                Text("DOCX, EPUB, LaTeX, RTF and ODT are available when a Pandoc executable is configured.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(12)
    }
}
