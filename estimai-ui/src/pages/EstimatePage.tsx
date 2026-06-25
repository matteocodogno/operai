import { getRouteApi } from '@tanstack/react-router'
import { EstimatorProvider } from '../context/EstimatorContext'
import EstimatorApp from '../EstimatorApp'

const route = getRouteApi('/_authed/estimates/$estimateId')

export default function EstimatePage() {
  const { estimateId } = route.useParams()
  return (
    <EstimatorProvider estimateId={estimateId}>
      <EstimatorApp />
    </EstimatorProvider>
  )
}
