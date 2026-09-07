import XCTest
@testable import Markedown

final class PlaceholderTests: XCTestCase {
    func testProjectLoads() {
        XCTAssertEqual(EditorMode.live.rawValue, "live")
    }
}

