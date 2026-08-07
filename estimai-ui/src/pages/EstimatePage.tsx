import { getRouteApi } from '@tanstack/react-router'
import { EstimatorProvider } from '../context/EstimatorContext'
import EstimatorApp from '../EstimatorApp'

// T13 (specs/003-suite-shell/tasks.md): route id no longer includes the
// `_authed` prefix — the guarding layout route it belonged to was removed
// (AC-2.3, src/router.tsx). The route itself (path, loader, component) is
// unchanged; only its id in the tree shifted up one level.
const route = getRouteApi('/estimates/$estimateId')

/**
 * EstimatePage — mounts after the router loader resolves the estimate from
 * the API. The loader guarantees the current user has SOME relationship to
 * the estimate — owner, editor, or viewer (T16, specs/013-estimate-sharing/
 * tasks.md: `EstimateFull.access`) — or redirects to /estimates (404 / error,
 * unchanged from spec 001).
 *
 * The loaded `content` (params, releases, acts) is fed into EstimatorProvider
 * as initial state, alongside the caller's `access` and `version` (T16); all
 * subsequent mutations flow through the context and are auto-saved via
 * debounced, `If-Match`-guarded PUT to the API when `canEdit` — never for a
 * viewer (AC-1.1, AC-1.2, AC-2.2, AC-3.1, AC-4.1, AC-4.2). `owner` and
 * `collaboratorCount` (T22, specs/013-estimate-sharing/tasks.md) are also
 * threaded straight through from `EstimateFull` — the toolbar's
 * Collaborators button/"Shared by" chip and `CollaboratorsDialog` read them
 * from context rather than this page re-fetching or re-deriving anything.
 */
export default function EstimatePage() {
  const { estimateId } = route.useParams()
  const estimate = route.useLoaderData()

  // T16 (specs/013-estimate-sharing/tasks.md; plan.md "### Frontend
  // (estimai-ui)"): the remount key moves from `updatedAt` to `version`.
  // `updatedAt` was never a safe precondition token (ADR-0038's own
  // rejection of it — millisecond/microsecond round-trip mismatches make it
  // fragile); `version` is the same integer optimistic-concurrency token
  // the autosave effect already tracks. It still serves this key's original
  // purpose (forcing a full EstimatorProvider remount whenever the
  // router-loaded data changes under TanStack Router's stale-while-
  // revalidate behaviour) and, as of this feature, is also the value that
  // changes on a "Reload latest" route invalidate (T18, design.md US-4):
  // the loader refetches, `estimate.version` changes, and the provider
  // remounts fresh — discarding only what was superseded, never anything
  // the user hadn't already lost per AC-4.2.
  const providerKey = estimate.version

  return (
    <EstimatorProvider
      key={providerKey}
      estimateId={estimateId}
      initialName={estimate.name}
      initialAuthor={estimate.author}
      initialParams={estimate.content.params}
      initialReleases={estimate.content.releases}
      initialActs={estimate.content.acts}
      initialAccess={estimate.access}
      initialVersion={estimate.version}
      initialOwner={estimate.owner}
      initialCollaboratorCount={estimate.collaboratorCount}
    >
      <EstimatorApp />
    </EstimatorProvider>
  )
}
