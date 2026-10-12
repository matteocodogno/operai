import { getJson } from './api'

/**
 * `GET /suppliers` — the supplier names already used on assets in the caller's
 * entity scope (either capability; 403 otherwise), alphabetical, one spelling
 * per supplier. It takes no parameter: the supplier field filters the list in
 * the browser, so what is being typed never reaches the server.
 */
export const listSuppliers = (init?: RequestInit): Promise<{ suppliers: string[] }> =>
  getJson<{ suppliers: string[] }>('/suppliers', init)
