import SwiftUI

private struct MarkedownControllerFocusedValueKey: FocusedValueKey {
    typealias Value = AppController
}

extension FocusedValues {
    var markedownController: AppController? {
        get { self[MarkedownControllerFocusedValueKey.self] }
        set { self[MarkedownControllerFocusedValueKey.self] = newValue }
    }
}

@MainActor
@main
struct MarkedownApp: App {
    @State private var settings = AppSettings()
    @State private var runtime = AppRuntime()

    var body: some Scene {
        WindowGroup(id: "workspace") {
            WorkspaceSceneRoot(settings: settings, runtime: runtime)
        }
        .defaultLaunchBehavior(.presented)
        .defaultSize(width: 1180, height: 780)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            MarkedownCommands()
        }

        Settings {
            SettingsView(settings: settings)
        }
    }
}

@MainActor
private struct WorkspaceSceneRoot: View {
    @State private var controller: AppController

    init(settings: AppSettings, runtime: AppRuntime) {
        _controller = State(
            initialValue: AppController(settings: settings, runtime: runtime)
        )
    }

    var body: some View {
        WorkspaceView(controller: controller)
            .frame(minWidth: 760, minHeight: 520)
            .focusedSceneValue(\.markedownController, controller)
            .task {
                await controller.start()
            }
            .onOpenURL { url in
                controller.openURL(url)
            }
    }
}
