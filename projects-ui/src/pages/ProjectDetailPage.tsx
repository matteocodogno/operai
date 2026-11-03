import { useParams } from '@tanstack/react-router'

/**
 * ProjectDetailPage — one project: details, state actions, team, contracts.
 * PLACEHOLDER (T11): T13 fills it (AC-1.2 – AC-1.7), T14 adds the contracts.
 */
export default function ProjectDetailPage() {
  const { id } = useParams({ from: '/$id' })
  return <section data-testid="project-detail-page" data-project-id={id} />
}
