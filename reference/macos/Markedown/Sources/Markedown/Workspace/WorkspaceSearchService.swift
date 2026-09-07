import Foundation

struct WorkspaceSearchOptions: Hashable, Sendable {
    var caseSensitive: Bool
    var maximumResults: Int?
    var previewCharacterLimit: Int

    init(
        caseSensitive: Bool = false,
        maximumResults: Int? = nil,
        previewCharacterLimit: Int = 180
    ) {
        self.caseSensitive = caseSensitive
        self.maximumResults = maximumResults
        self.previewCharacterLimit = max(40, previewCharacterLimit)
    }
}

actor WorkspaceSearchService {
    private struct SearchRequest: Sendable {
        let query: String
        let rootURL: URL
        let options: WorkspaceSearchOptions
    }

    private struct ActiveSearch: Sendable {
        let id: UUID
        let task: Task<[WorkspaceSearchResult], any Error>
    }

    private var activeSearch: ActiveSearch?

    func search(
        for query: String,
        in rootURL: URL,
        options: WorkspaceSearchOptions = WorkspaceSearchOptions()
    ) async throws -> [WorkspaceSearchResult] {
        try Task.checkCancellation()
        guard !query.isEmpty, options.maximumResults != 0 else {
            return []
        }

        activeSearch?.task.cancel()
        let searchID = UUID()
        let request = SearchRequest(
            query: query,
            rootURL: rootURL.standardizedFileURL,
            options: options
        )
        let task = Task.detached(priority: .userInitiated) {
            try Self.performSearch(request)
        }
        activeSearch = ActiveSearch(id: searchID, task: task)

        do {
            let results = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            try Task.checkCancellation()
            clearSearch(ifMatching: searchID)
            return results
        } catch {
            clearSearch(ifMatching: searchID)
            throw error
        }
    }

    func cancelCurrentSearch() {
        activeSearch?.task.cancel()
        activeSearch = nil
    }

    private func clearSearch(ifMatching id: UUID) {
        if activeSearch?.id == id {
            activeSearch = nil
        }
    }

    private nonisolated static func performSearch(
        _ request: SearchRequest
    ) throws -> [WorkspaceSearchResult] {
        try Task.checkCancellation()
        let files = try WorkspaceFilePolicy.recursiveDocumentURLs(at: request.rootURL)
        var results: [WorkspaceSearchResult] = []

        for fileURL in files {
            try Task.checkCancellation()
            guard let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe),
                  var source = String(data: data, encoding: .utf8) else {
                continue
            }
            if source.first == "\u{FEFF}" {
                source.removeFirst()
            }
            try appendMatches(
                in: source,
                fileURL: fileURL,
                request: request,
                results: &results
            )
            if reachedLimit(results.count, maximum: request.options.maximumResults) {
                break
            }
        }

        return results
    }

    private nonisolated static func appendMatches(
        in source: String,
        fileURL: URL,
        request: SearchRequest,
        results: inout [WorkspaceSearchResult]
    ) throws {
        var lineNumber = 1
        var lineStart = source.startIndex

        while true {
            try Task.checkCancellation()
            let newlineIndex = source[lineStart...].firstIndex { $0.isNewline }
            let lineEnd = newlineIndex ?? source.endIndex
            let line = source[lineStart..<lineEnd]
            try appendMatches(
                in: line,
                lineNumber: lineNumber,
                fileURL: fileURL,
                request: request,
                results: &results
            )

            if reachedLimit(results.count, maximum: request.options.maximumResults) {
                return
            }
            guard let newlineIndex else {
                return
            }
            lineStart = source.index(after: newlineIndex)
            lineNumber += 1
        }
    }

    private nonisolated static func appendMatches(
        in line: Substring,
        lineNumber: Int,
        fileURL: URL,
        request: SearchRequest,
        results: inout [WorkspaceSearchResult]
    ) throws {
        var compareOptions: String.CompareOptions = [.literal]
        if !request.options.caseSensitive {
            compareOptions.insert(.caseInsensitive)
        }
        var searchStart = line.startIndex

        while searchStart < line.endIndex,
              let match = line.range(
                  of: request.query,
                  options: compareOptions,
                  range: searchStart..<line.endIndex,
                  locale: nil
              ) {
            try Task.checkCancellation()
            let column = line.distance(from: line.startIndex, to: match.lowerBound) + 1
            results.append(
                WorkspaceSearchResult(
                    fileURL: fileURL,
                    line: lineNumber,
                    column: column,
                    preview: preview(
                        for: line,
                        around: match,
                        characterLimit: request.options.previewCharacterLimit
                    )
                )
            )
            if reachedLimit(results.count, maximum: request.options.maximumResults) {
                return
            }
            searchStart = match.upperBound
        }
    }

    private nonisolated static func preview(
        for line: Substring,
        around match: Range<String.Index>,
        characterLimit: Int
    ) -> String {
        let matchLength = line.distance(from: match.lowerBound, to: match.upperBound)
        let limit = max(characterLimit, matchLength)
        guard line.count > limit else {
            return String(line).trimmingCharacters(in: .whitespaces)
        }

        let availableContext = max(0, limit - matchLength)
        let desiredLeadingContext = availableContext / 2
        let leadingDistance = line.distance(from: line.startIndex, to: match.lowerBound)
        let leadingCount = min(desiredLeadingContext, leadingDistance)
        var lowerBound = line.index(match.lowerBound, offsetBy: -leadingCount)

        let usedBeforeMatch = line.distance(from: lowerBound, to: match.lowerBound)
        let desiredTrailingContext = availableContext - usedBeforeMatch
        let trailingDistance = line.distance(from: match.upperBound, to: line.endIndex)
        let trailingCount = min(desiredTrailingContext, trailingDistance)
        var upperBound = line.index(match.upperBound, offsetBy: trailingCount)

        let currentLength = line.distance(from: lowerBound, to: upperBound)
        if currentLength < limit {
            let remaining = limit - currentLength
            let extraLeading = min(
                remaining,
                line.distance(from: line.startIndex, to: lowerBound)
            )
            lowerBound = line.index(lowerBound, offsetBy: -extraLeading)
            let stillRemaining = remaining - extraLeading
            let extraTrailing = min(
                stillRemaining,
                line.distance(from: upperBound, to: line.endIndex)
            )
            upperBound = line.index(upperBound, offsetBy: extraTrailing)
        }

        var value = String(line[lowerBound..<upperBound])
            .trimmingCharacters(in: .whitespaces)
        if lowerBound != line.startIndex {
            value = "..." + value
        }
        if upperBound != line.endIndex {
            value += "..."
        }
        return value
    }

    private nonisolated static func reachedLimit(
        _ resultCount: Int,
        maximum: Int?
    ) -> Bool {
        guard let maximum else { return false }
        return resultCount >= max(0, maximum)
    }
}
