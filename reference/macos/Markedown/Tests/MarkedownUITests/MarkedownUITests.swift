import XCTest

@MainActor
final class MarkedownUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testApplicationLaunchesIntoEditor() throws {
        let application = launchApplication()

        XCTAssertTrue(application.windows["Markedown"].waitForExistence(timeout: 5))
        XCTAssertTrue(application.groups["editor-workspace"].exists)
    }

    func testSidebarTabsModesAndFindBar() throws {
        let application = launchApplication()
        let workspace = application.groups["editor-workspace"]
        XCTAssertTrue(workspace.waitForExistence(timeout: 5))

        let sidebar = application.groups["workspace-sidebar"]
        XCTAssertTrue(sidebar.exists)
        application.typeKey("s", modifierFlags: [.command, .control])
        XCTAssertTrue(sidebar.waitForNonExistence(timeout: 2))
        application.typeKey("s", modifierFlags: [.command, .control])
        XCTAssertTrue(sidebar.waitForExistence(timeout: 2))

        application.typeKey("n", modifierFlags: .command)
        XCTAssertGreaterThanOrEqual(application.buttons.matching(identifier: "document-tab").count, 2)

        application.typeKey("/", modifierFlags: .command)
        XCTAssertTrue(application.staticTexts["editor-mode-source"].waitForExistence(timeout: 2))
        application.typeKey("/", modifierFlags: [.command, .option])
        XCTAssertTrue(application.staticTexts["editor-mode-live"].waitForExistence(timeout: 2))

        application.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(application.textFields["find-field"].waitForExistence(timeout: 2))
        XCTAssertTrue(application.buttons["find-close"].exists)
        application.buttons["find-close"].click()
    }

    func testSettingsWindowClosesWithKeyboardShortcut() throws {
        let application = launchApplication()

        application.menuBars.menuBarItems["Markedown"].click()
        let settingsMenuItem = application.menuItems
            .matching(identifier: "menuAction:")
            .firstMatch
        XCTAssertTrue(settingsMenuItem.waitForExistence(timeout: 2))
        settingsMenuItem.click()
        let settingsWindow = application.windows
            .matching(identifier: "com_apple_SwiftUI_Settings_window")
            .firstMatch
        XCTAssertTrue(settingsWindow.waitForExistence(timeout: 3))

        application.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(settingsWindow.waitForNonExistence(timeout: 3))
        XCTAssertTrue(application.groups["editor-workspace"].exists)
    }

    private func launchApplication() -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments = [
            "--ui-testing",
            "-ApplePersistenceIgnoreState", "YES"
        ]
        application.launch()
        if !application.windows["Markedown"].waitForExistence(timeout: 3) {
            application.typeKey("n", modifierFlags: .command)
            XCTAssertTrue(application.windows["Markedown"].waitForExistence(timeout: 3))
        }
        XCTAssertTrue(application.groups["editor-workspace"].waitForExistence(timeout: 5))
        application.activate()
        return application
    }
}
