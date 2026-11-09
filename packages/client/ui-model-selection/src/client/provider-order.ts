/** Shared provider display order for the composer and command model pickers. */

/**
 * Vendor-neutral fork: keep the catalog order; no provider is promoted.
 * @param groups - Provider groups in catalog order.
 * @returns a sorted copy; model order within each group is unchanged.
 */
export function orderModelProviders<T extends { readonly id: string }>(groups: readonly T[]): T[] {
  return [...groups]
}
