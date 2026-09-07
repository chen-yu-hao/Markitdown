import AppKit
import Foundation
import PDFKit
import WebKit

enum WebKitRenderExporterError: LocalizedError, Equatable, Sendable {
  case invalidHTML
  case invalidDestination(URL)
  case invalidPageSize(String)
  case navigationFailed(String)
  case contentMeasurementFailed(String)
  case documentTooLarge(width: Int, height: Int)
  case pageLimitExceeded(Int)
  case pdfRenderingFailed(String)
  case imageRenderingFailed(String)
  case pdfCreationFailed
  case imageCreationFailed
  case writeFailed(path: String, reason: String)

  var errorDescription: String? {
    switch self {
    case .invalidHTML:
      String(localized: "error.render.invalid-html")
    case .invalidDestination(let url):
      localizedFormat("error.render.invalid-destination", url.absoluteString)
    case .invalidPageSize(let value):
      localizedFormat("error.render.invalid-page-size", value)
    case .navigationFailed(let reason):
      localizedFormat("error.render.navigation-failed", reason)
    case .contentMeasurementFailed(let reason):
      localizedFormat("error.render.measurement-failed", reason)
    case .documentTooLarge(let width, let height):
      localizedFormat("error.render.document-too-large", width, height)
    case .pageLimitExceeded(let count):
      localizedFormat("error.render.page-limit", count)
    case .pdfRenderingFailed(let reason):
      localizedFormat("error.render.pdf-failed", reason)
    case .imageRenderingFailed(let reason):
      localizedFormat("error.render.image-failed", reason)
    case .pdfCreationFailed:
      String(localized: "error.render.pdf-invalid")
    case .imageCreationFailed:
      String(localized: "error.render.image-invalid")
    case .writeFailed(let path, let reason):
      localizedFormat("error.render.write-failed", path, reason)
    }
  }
}

@MainActor
final class WebKitRenderExporter: HTMLRenderExporting {
  struct Limits: Hashable, Sendable {
    var imageViewportWidth: CGFloat = 1_200
    var initialViewportHeight: CGFloat = 900
    var maximumImageDimension = 16_384
    var maximumImagePixelCount = 40_000_000
    var maximumDocumentDimension: CGFloat = 1_000_000
    var maximumPDFPageCount = 2_000

    init(
      imageViewportWidth: CGFloat = 1_200,
      initialViewportHeight: CGFloat = 900,
      maximumImageDimension: Int = 16_384,
      maximumImagePixelCount: Int = 40_000_000,
      maximumDocumentDimension: CGFloat = 1_000_000,
      maximumPDFPageCount: Int = 2_000
    ) {
      precondition(imageViewportWidth > 0)
      precondition(initialViewportHeight > 0)
      precondition(maximumImageDimension > 0)
      precondition(maximumImagePixelCount > 0)
      precondition(maximumDocumentDimension > 0)
      precondition(maximumPDFPageCount > 0)

      self.imageViewportWidth = imageViewportWidth
      self.initialViewportHeight = initialViewportHeight
      self.maximumImageDimension = maximumImageDimension
      self.maximumImagePixelCount = maximumImagePixelCount
      self.maximumDocumentDimension = maximumDocumentDimension
      self.maximumPDFPageCount = maximumPDFPageCount
    }
  }

  struct PageGeometry: Hashable, Sendable {
    let width: CGFloat
    let height: CGFloat
  }

  struct PixelSize: Hashable, Sendable {
    let width: Int
    let height: Int

    var pixelCount: Int { width * height }
  }

  private let limits: Limits

  init(limits: Limits = Limits()) {
    self.limits = limits
  }

  func export(_ request: HTMLRenderExportRequest, to destinationURL: URL) async throws {
    guard destinationURL.isFileURL,
      !destinationURL.hasDirectoryPath,
      FileManager.default.fileExists(
        atPath: destinationURL.deletingLastPathComponent().path
      )
    else {
      throw WebKitRenderExporterError.invalidDestination(destinationURL)
    }

    let pageGeometry = try Self.pageGeometry(for: request.pageSize)
    let viewportWidth =
      request.target == .pdf
      ? pageGeometry.width
      : limits.imageViewportWidth
    let securedHTML = try Self.securedHTMLData(
      from: request.htmlData,
      pageGeometry: request.target == .pdf ? pageGeometry : nil
    )
    let webView = makeWebView(
      width: viewportWidth,
      height: request.target == .pdf
        ? pageGeometry.height
        : limits.initialViewportHeight
    )
    let navigation = NavigationAwaiter()
    webView.navigationDelegate = navigation

    try await navigation.load(securedHTML, in: webView)
    try Task.checkCancellation()

    let documentSize = try await measureDocument(in: webView)
    try validate(documentSize)

    let outputData: Data
    switch request.target {
    case .pdf:
      outputData = try await makePDF(
        from: webView,
        documentSize: documentSize,
        pageGeometry: pageGeometry
      )
    case .image:
      outputData = try await makePNG(from: webView, documentSize: documentSize)
    }

    try Task.checkCancellation()
    try await Self.writeAtomically(outputData, to: destinationURL)
  }

  nonisolated static func pageGeometry(for pageSize: String) throws -> PageGeometry {
    switch pageSize.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "a4":
      // ISO 216 dimensions converted from millimetres to PostScript points.
      PageGeometry(width: 595.28, height: 841.89)
    case "letter", "us letter", "us-letter":
      PageGeometry(width: 612, height: 792)
    default:
      throw WebKitRenderExporterError.invalidPageSize(pageSize)
    }
  }

  nonisolated static func constrainedPixelSize(
    for sourceSize: CGSize,
    maximumDimension: Int,
    maximumPixelCount: Int
  ) throws -> PixelSize {
    guard sourceSize.width.isFinite,
      sourceSize.height.isFinite,
      sourceSize.width > 0,
      sourceSize.height > 0,
      maximumDimension > 0,
      maximumPixelCount > 0
    else {
      throw WebKitRenderExporterError.contentMeasurementFailed(
        "The document reported invalid dimensions."
      )
    }

    let dimensionScale = min(
      1,
      CGFloat(maximumDimension) / max(sourceSize.width, sourceSize.height)
    )
    let sourcePixelCount = sourceSize.width * sourceSize.height
    let pixelScale = min(
      1,
      sqrt(CGFloat(maximumPixelCount) / sourcePixelCount)
    )
    let scale = min(dimensionScale, pixelScale)
    let width = max(1, Int((sourceSize.width * scale).rounded(.down)))
    let height = max(1, Int((sourceSize.height * scale).rounded(.down)))

    guard width <= maximumDimension,
      height <= maximumDimension,
      width * height <= maximumPixelCount
    else {
      throw WebKitRenderExporterError.documentTooLarge(
        width: Int(sourceSize.width.rounded(.up)),
        height: Int(sourceSize.height.rounded(.up))
      )
    }
    return PixelSize(width: width, height: height)
  }

  private func makeWebView(width: CGFloat, height: CGFloat) -> WKWebView {
    let webpagePreferences = WKWebpagePreferences()
    webpagePreferences.allowsContentJavaScript = false

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences = webpagePreferences
    configuration.suppressesIncrementalRendering = true

    let webView = WKWebView(
      frame: CGRect(x: 0, y: 0, width: width, height: height),
      configuration: configuration
    )
    webView.allowsMagnification = false
    return webView
  }

  private func measureDocument(in webView: WKWebView) async throws -> CGSize {
    do {
      // Page-authored JavaScript remains disabled. This app-owned query only reads layout.
      let result = try await webView.callAsyncJavaScript(
        """
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }
        const root = document.documentElement;
        const body = document.body;
        return [
            Math.max(root.scrollWidth, root.offsetWidth, body ? body.scrollWidth : 0, body ? body.offsetWidth : 0),
            Math.max(root.scrollHeight, root.offsetHeight, body ? body.scrollHeight : 0, body ? body.offsetHeight : 0)
        ];
        """,
        arguments: [:],
        contentWorld: .page
      )
      guard let values = result as? [Any],
        values.count == 2,
        let width = values[0] as? NSNumber,
        let height = values[1] as? NSNumber
      else {
        throw WebKitRenderExporterError.contentMeasurementFailed(
          "The layout query returned an unexpected value."
        )
      }
      return CGSize(width: width.doubleValue, height: height.doubleValue)
    } catch let error as WebKitRenderExporterError {
      throw error
    } catch {
      throw WebKitRenderExporterError.contentMeasurementFailed(
        String(describing: error)
      )
    }
  }

  private func validate(_ documentSize: CGSize) throws {
    guard documentSize.width.isFinite,
      documentSize.height.isFinite,
      documentSize.width > 0,
      documentSize.height > 0
    else {
      throw WebKitRenderExporterError.contentMeasurementFailed(
        "The document reported invalid dimensions."
      )
    }
    guard documentSize.width <= limits.maximumDocumentDimension,
      documentSize.height <= limits.maximumDocumentDimension
    else {
      throw WebKitRenderExporterError.documentTooLarge(
        width: Int(documentSize.width.rounded(.up)),
        height: Int(documentSize.height.rounded(.up))
      )
    }
  }

  private func makePDF(
    from webView: WKWebView,
    documentSize: CGSize,
    pageGeometry: PageGeometry
  ) async throws -> Data {
    let pageCount = max(1, Int(ceil(documentSize.height / pageGeometry.height)))
    guard pageCount <= limits.maximumPDFPageCount else {
      throw WebKitRenderExporterError.pageLimitExceeded(pageCount)
    }

    let renderedHeight = CGFloat(pageCount) * pageGeometry.height
    webView.setFrameSize(NSSize(width: pageGeometry.width, height: renderedHeight))
    webView.layoutSubtreeIfNeeded()
    await Task.yield()

    let document = PDFDocument()
    for pageIndex in 0..<pageCount {
      try Task.checkCancellation()
      let configuration = WKPDFConfiguration()
      configuration.rect = CGRect(
        x: 0,
        y: CGFloat(pageIndex) * pageGeometry.height,
        width: pageGeometry.width,
        height: pageGeometry.height
      )
      configuration.allowTransparentBackground = false

      let pageData: Data
      do {
        pageData = try await createPDF(in: webView, configuration: configuration)
      } catch {
        throw WebKitRenderExporterError.pdfRenderingFailed(String(describing: error))
      }
      guard let renderedPage = PDFDocument(data: pageData),
        renderedPage.pageCount > 0
      else {
        throw WebKitRenderExporterError.pdfCreationFailed
      }
      for index in 0..<renderedPage.pageCount {
        guard let page = renderedPage.page(at: index) else {
          throw WebKitRenderExporterError.pdfCreationFailed
        }
        document.insert(page, at: document.pageCount)
      }
    }

    guard document.pageCount > 0,
      let data = document.dataRepresentation(),
      !data.isEmpty
    else {
      throw WebKitRenderExporterError.pdfCreationFailed
    }
    return data
  }

  private func makePNG(from webView: WKWebView, documentSize: CGSize) async throws -> Data {
    let pixelSize = try Self.constrainedPixelSize(
      for: documentSize,
      maximumDimension: limits.maximumImageDimension,
      maximumPixelCount: limits.maximumImagePixelCount
    )
    webView.setFrameSize(documentSize)
    webView.layoutSubtreeIfNeeded()
    await Task.yield()

    let configuration = WKSnapshotConfiguration()
    configuration.rect = CGRect(origin: .zero, size: documentSize)
    configuration.snapshotWidth = NSNumber(value: pixelSize.width)
    configuration.afterScreenUpdates = true

    let image: NSImage
    do {
      image = try await snapshot(in: webView, configuration: configuration)
    } catch {
      throw WebKitRenderExporterError.imageRenderingFailed(String(describing: error))
    }
    return try Self.pngData(from: image, pixelSize: pixelSize)
  }

  private func createPDF(
    in webView: WKWebView,
    configuration: WKPDFConfiguration
  ) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      webView.createPDF(configuration: configuration) { result in
        continuation.resume(with: result)
      }
    }
  }

  private func snapshot(
    in webView: WKWebView,
    configuration: WKSnapshotConfiguration
  ) async throws -> NSImage {
    try await withCheckedThrowingContinuation { continuation in
      webView.takeSnapshot(with: configuration) { image, error in
        if let image {
          continuation.resume(returning: image)
        } else {
          continuation.resume(
            throwing: error ?? WebKitRenderExporterError.imageCreationFailed
          )
        }
      }
    }
  }

  nonisolated private static func securedHTMLData(
    from htmlData: Data,
    pageGeometry: PageGeometry?
  ) throws -> Data {
    guard var html = String(data: htmlData, encoding: .utf8),
      !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      throw WebKitRenderExporterError.invalidHTML
    }

    var additions = """
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; script-src 'none'; img-src data: file:; media-src data: file:; font-src data:; style-src 'unsafe-inline'">
      """
    if let pageGeometry {
      additions += """

        <style id="markedown-webkit-export-style">
        @page { size: \(pageGeometry.width)pt \(pageGeometry.height)pt; margin: 0; }
        html, body { width: \(pageGeometry.width)px; max-width: \(pageGeometry.width)px; }
        body { overflow-wrap: anywhere; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style>
        """
    }

    if let headEnd = html.range(of: "</head>", options: .caseInsensitive) {
      html.insert(contentsOf: additions + "\n", at: headEnd.lowerBound)
    } else {
      html = additions + "\n" + html
    }
    return Data(html.utf8)
  }

  nonisolated private static func pngData(
    from image: NSImage,
    pixelSize: PixelSize
  ) throws -> Data {
    guard
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelSize.width,
        pixelsHigh: pixelSize.height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      ), let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else {
      throw WebKitRenderExporterError.imageCreationFailed
    }

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    image.draw(
      in: NSRect(x: 0, y: 0, width: pixelSize.width, height: pixelSize.height),
      from: .zero,
      operation: .copy,
      fraction: 1,
      respectFlipped: true,
      hints: [.interpolation: NSImageInterpolation.high]
    )
    context.flushGraphics()

    guard let data = bitmap.representation(using: .png, properties: [:]),
      !data.isEmpty
    else {
      throw WebKitRenderExporterError.imageCreationFailed
    }
    return data
  }

  nonisolated private static func writeAtomically(_ data: Data, to url: URL) async throws {
    do {
      try await Task.detached(priority: .utility) {
        try data.write(to: url, options: .atomic)
      }.value
    } catch {
      throw WebKitRenderExporterError.writeFailed(
        path: url.path,
        reason: String(describing: error)
      )
    }
  }
}

@MainActor
private final class NavigationAwaiter: NSObject, WKNavigationDelegate {
  private var continuation: CheckedContinuation<Void, any Error>?

  func load(_ htmlData: Data, in webView: WKWebView) async throws {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let baseURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      guard
        webView.load(
          htmlData,
          mimeType: "text/html",
          characterEncodingName: "utf-8",
          baseURL: baseURL
        ) != nil
      else {
        finish(
          with: .failure(
            WebKitRenderExporterError.navigationFailed(
              "WebKit did not create a navigation request."
            )
          )
        )
        return
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    finish(with: .success(()))
  }

  func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: any Error
  ) {
    finish(
      with: .failure(
        WebKitRenderExporterError.navigationFailed(String(describing: error))
      )
    )
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: any Error
  ) {
    finish(
      with: .failure(
        WebKitRenderExporterError.navigationFailed(String(describing: error))
      )
    )
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    finish(
      with: .failure(
        WebKitRenderExporterError.navigationFailed(
          "The WebKit content process terminated unexpectedly."
        )
      )
    )
  }

  private func finish(with result: Result<Void, any Error>) {
    guard let continuation else { return }
    self.continuation = nil
    continuation.resume(with: result)
  }
}
