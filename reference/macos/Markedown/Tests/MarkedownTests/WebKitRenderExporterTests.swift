import CoreGraphics
import Foundation
import XCTest

@testable import Markedown

final class WebKitRenderExporterTests: XCTestCase {
  @MainActor
  func testRealExportsProducePDFAndPNGFiles() async throws {
    let directoryURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("Markedown-WebKitExportTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directoryURL) }

    let service = MarkdownExportService()
    let exporter = WebKitRenderExporter()
    let pdfURL = directoryURL.appendingPathComponent("document.pdf")
    let pngURL = directoryURL.appendingPathComponent("document.png")
    let markdown = "# 导出测试\n\nHello **Markedown**."

    try await exporter.export(
      service.makeRenderRequest(markdown: markdown, format: .pdf),
      to: pdfURL
    )
    try await exporter.export(
      service.makeRenderRequest(markdown: markdown, format: .image),
      to: pngURL
    )

    let pdf = try Data(contentsOf: pdfURL)
    let png = try Data(contentsOf: pngURL)
    XCTAssertTrue(pdf.starts(with: Data("%PDF-".utf8)))
    XCTAssertTrue(png.starts(with: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])))
  }

  func testPageGeometrySupportsA4AndLetterAliases() throws {
    let a4 = try WebKitRenderExporter.pageGeometry(for: "A4")
    let letter = try WebKitRenderExporter.pageGeometry(for: " US Letter ")

    XCTAssertEqual(a4.width, 595.28, accuracy: 0.01)
    XCTAssertEqual(a4.height, 841.89, accuracy: 0.01)
    XCTAssertEqual(letter.width, 612, accuracy: 0.01)
    XCTAssertEqual(letter.height, 792, accuracy: 0.01)
  }

  func testPageGeometryRejectsUnknownSizes() {
    XCTAssertThrowsError(try WebKitRenderExporter.pageGeometry(for: "Legal")) { error in
      XCTAssertEqual(
        error as? WebKitRenderExporterError,
        .invalidPageSize("Legal")
      )
    }
  }

  func testConstrainedPixelSizePreservesLongDocumentWithinBudgets() throws {
    let result = try WebKitRenderExporter.constrainedPixelSize(
      for: CGSize(width: 1_200, height: 60_000),
      maximumDimension: 16_384,
      maximumPixelCount: 40_000_000
    )

    XCTAssertLessThanOrEqual(result.width, 16_384)
    XCTAssertLessThanOrEqual(result.height, 16_384)
    XCTAssertLessThanOrEqual(result.pixelCount, 40_000_000)
    XCTAssertEqual(
      Double(result.width) / Double(result.height),
      1_200 / 60_000,
      accuracy: 0.001
    )
  }

  func testConstrainedPixelSizeAlsoHonorsPixelCount() throws {
    let result = try WebKitRenderExporter.constrainedPixelSize(
      for: CGSize(width: 10_000, height: 10_000),
      maximumDimension: 16_384,
      maximumPixelCount: 4_000_000
    )

    XCTAssertEqual(result.width, 2_000)
    XCTAssertEqual(result.height, 2_000)
    XCTAssertEqual(result.pixelCount, 4_000_000)
  }

  func testConstrainedPixelSizeRejectsInvalidDimensions() {
    XCTAssertThrowsError(
      try WebKitRenderExporter.constrainedPixelSize(
        for: CGSize(width: 0, height: 100),
        maximumDimension: 16_384,
        maximumPixelCount: 40_000_000
      )
    )
  }
}
