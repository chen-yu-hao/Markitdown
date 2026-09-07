import Foundation

@MainActor
final class AppRuntime {
    private final class WeakOwner {
        weak var value: AppController?

        init(_ value: AppController) {
            self.value = value
        }
    }

    private struct DocumentClaim {
        let documentID: DocumentID
        let owner: WeakOwner
    }

    private var documentClaims: [URL: DocumentClaim] = [:]
    private var recoveryClaims: [DocumentID: WeakOwner] = [:]
    private var startupRestorationClaimed = false

    func claimStartupRestoration() -> Bool {
        guard !startupRestorationClaimed else { return false }
        startupRestorationClaimed = true
        return true
    }

    func claimDocument(
        at url: URL,
        documentID: DocumentID,
        owner: AppController
    ) -> Bool {
        let key = Self.canonicalURL(url)
        if let existing = documentClaims[key], existing.owner.value != nil {
            return existing.documentID == documentID && existing.owner.value === owner
        }
        documentClaims[key] = DocumentClaim(
            documentID: documentID,
            owner: WeakOwner(owner)
        )
        return true
    }

    func releaseDocument(
        at url: URL,
        documentID: DocumentID,
        owner: AppController
    ) {
        let key = Self.canonicalURL(url)
        guard let existing = documentClaims[key],
              existing.documentID == documentID,
              existing.owner.value === owner else {
            return
        }
        documentClaims[key] = nil
    }

    func claimRecovery(_ documentID: DocumentID, owner: AppController) -> Bool {
        if let existing = recoveryClaims[documentID], existing.value != nil {
            return existing.value === owner
        }
        recoveryClaims[documentID] = WeakOwner(owner)
        return true
    }

    func releaseRecovery(_ documentID: DocumentID, owner: AppController) {
        guard recoveryClaims[documentID]?.value === owner else { return }
        recoveryClaims[documentID] = nil
    }

    private static func canonicalURL(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
