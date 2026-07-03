import { getRouteApi } from '@tanstack/react-router'
import { EstimatorProvider } from '../context/EstimatorContext'
import EstimatorApp from '../EstimatorApp'

const route = getRouteApi('/_authed/estimates/$estimateId')

/**
 * EstimatePage — mounts after the router loader resolves the estimate from
 * the API. The loader guarantees the estimate exists and is owned by the
 * current user (404 / error → redirect to /estimates).
 *
 * The loaded `content` (params, releases, acts) is fed into EstimatorProvider
 * as initial state; all subsequent mutations flow through the context and are
 * auto-saved via debounced PUT to the API (AC-1.1, AC-1.2, AC-2.2).
 */
export default function EstimatePage() {
  const { estimateId } = route.useParams()
  const estimate = route.useLoaderData()

  return (
    <EstimatorProvider
      estimateId={estimateId}
      initialName={estimate.name}
      initialAuthor={estimate.author}
      initialParams={estimate.content.params}
      initialReleases={estimate.content.releases}
      initialActs={estimate.content.acts}
    >
      <EstimatorApp />
    </EstimatorProvider>
  )
}
