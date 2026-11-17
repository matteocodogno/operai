/**
 * Playwright global setup of the shell e2e suite (specs/20261117-legal-entities, T41).
 *
 * It leaves the legal-entity registry in the state the journeys of that spec (and the CRM offer journeys, which now print the
 * issuer from the registry) start from, and the people they need to exist:
 *
 *   1. the registry SEEDED BY THE IMPORT: where an entity has no version, `mise run legal-entities:import` (T9) copies the CRM's
 *      legal details into version 1 (idempotent; skipped when both entities already have a version);
 *   2. both entities COMPLETE (AC-1.2): where a required value is missing or a value invalid, one registry save by the admin
 *      fixture fills it (nothing already valid is replaced; an entity in order gets no new version);
 *   3. a `welld_ch`-conditioned manager and a no-grant user, next to the admin (helpers/legalEntitiesFixtures.ts).
 *
 * It needs the stack the suite already needs (header of playwright.config.ts): `auth` with ENABLE_TEST_AUTH=true and its
 * migrations and seed applied (`cd auth && bun run db:release`), and, only on a database whose registry is still empty, the
 * compose Postgres with the CRM's database (the import reads it). It fails the whole run, naming what to run, when the registry
 * cannot be brought to that state: a journey that starts from an unseeded registry would fail for the wrong reason.
 *
 * `E2E_SKIP_LEGAL_ENTITIES_SETUP=1` skips it, for a run of specs that touch neither the registry nor an offer. It says so on
 * stderr; a run that skips it proves nothing about the registry.
 */
import { seedRegistry, setUpLegalEntityPeople, ENTITIES } from './helpers/legalEntitiesFixtures'

export default async function globalSetup(): Promise<void> {
  if (process.env['E2E_SKIP_LEGAL_ENTITIES_SETUP'] === '1') {
    console.error('[global-setup] E2E_SKIP_LEGAL_ENTITIES_SETUP=1: the legal-entity registry and its people are NOT prepared')
    return
  }
  const people = await setUpLegalEntityPeople()
  const seeded = await seedRegistry(people.admin)
  const summary = ENTITIES.map((entity) => `${entity} v${seeded[entity].version}`).join(', ')
  // names and versions only: no legal value is ever printed
  console.log(`[global-setup] legal-entity registry in order: ${summary}`)
}
