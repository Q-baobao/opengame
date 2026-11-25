/**
 * Repository-owned product identity used for cross-site attribution to OpenDesign / AMR.
 * Keep this value specific to this repository when syncing code between OpenMotion and OpenGame.
 */
export const PRODUCT_ID = 'opengame' as const;

export type ProductId = typeof PRODUCT_ID;

/** Prefix the checkout entry_id so AMR billing records distinguish OpenGame from OpenMotion. */
export function attributedEntryId(entryId: string): string {
  const trimmed = entryId.trim();
  if (!trimmed) return trimmed;
  const prefix = `${PRODUCT_ID}-`;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
}
