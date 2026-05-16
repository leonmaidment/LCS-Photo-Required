/**
 * clients.ts
 * ----------
 * Static registry of known LCS clients with canonical display names and
 * stable normalised keys for Make / Monday routing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Monday routing previously relied on exact free-typed client names.  Any
 * spelling variation or extra suffix (e.g. "Doswell Projects Ltd" vs
 * "Doswell Projects") would break board-lookup rules.  Instead, the app now
 * derives a stable `clientKey` (lowercase kebab-case) that Monday / Make
 * scenarios can match on reliably.
 *
 * ── Adding new clients ────────────────────────────────────────────────────
 * 1. Add an entry to KNOWN_CLIENTS below.
 * 2. Update the Make / Monday registry (see README "Make/Monday routing note").
 * Manual free-text entry continues to work — `deriveClientKey()` will
 * generate a best-effort key from any arbitrary string.
 *
 * ── Future dropdown ───────────────────────────────────────────────────────
 * The `KNOWN_CLIENTS` array is already wired to an autocomplete suggestion
 * list in NewVisitScreen.  When a full controlled-select dropdown is
 * preferred, replace the TextInput + suggestion list with a Picker/Modal
 * that restricts choices to this registry (while keeping a "Other…" manual
 * entry escape hatch).
 */

export interface KnownClient {
  /** Stable routing key — lowercase kebab-case, never changes even if display name is updated. */
  key: string;
  /** Canonical display name shown in the app and sent as clientDisplayName in metadata. */
  displayName: string;
}

/**
 * Static list of known LCS clients.
 * Keys are permanent identifiers — do NOT rename a key once it is live in
 * Make / Monday, as existing routing rules depend on it.
 */
export const KNOWN_CLIENTS: KnownClient[] = [
  { key: 'doswell-projects',       displayName: 'Doswell Projects' },
  { key: 'appledown-construction', displayName: 'Appledown Construction' },
  { key: 'benridge',               displayName: 'Benridge' },
  { key: 'gildan-brickwork',       displayName: 'Gildan Brickwork' },
  { key: 'owlsworth',              displayName: 'Owlsworth' },
  { key: 'birchen-construction',   displayName: 'Birchen Construction' },
];

/**
 * Returns the KnownClient entry whose displayName matches the given text
 * (case-insensitive, ignoring trailing punctuation such as "Ltd", "Limited",
 * "&amp; Sons", etc.).
 *
 * Returns `undefined` when no known client matches — callers should then
 * fall back to `deriveClientKey(text)`.
 */
export function findKnownClient(text: string): KnownClient | undefined {
  const normalised = text.trim().toLowerCase();
  return KNOWN_CLIENTS.find(c => {
    const key = c.displayName.toLowerCase();
    return normalised === key || normalised.startsWith(key);
  });
}

/**
 * Derives a stable lowercase kebab-case key from any client name string.
 *
 * Algorithm:
 *   1. Lowercase.
 *   2. Strip common suffixes (ltd, limited, plc, llp, inc, llc, &amp; co).
 *   3. Replace non-alphanumeric runs with a single hyphen.
 *   4. Strip leading/trailing hyphens.
 *   5. Collapse multiple hyphens.
 *   6. Cap at 64 characters.
 *
 * Examples:
 *   "Doswell Projects Ltd"      → "doswell-projects"
 *   "Appledown Construction"    → "appledown-construction"
 *   "J. Smith &amp; Co."        → "j-smith-co"
 *
 * If a known client matches, its permanent key is returned instead so the
 * derived value stays stable even if the user types slight variations.
 */
export function deriveClientKey(text: string): string {
  if (!text.trim()) return '';

  // Prefer the permanent key from the registry when possible.
  const known = findKnownClient(text);
  if (known) return known.key;

  return text
    .toLowerCase()
    // Strip common legal suffixes
    .replace(/\b(ltd|limited|plc|llp|inc|llc|&\s*co\.?|and\s+co\.?)\b/g, '')
    // Non-alphanumeric → hyphen
    .replace(/[^a-z0-9]+/g, '-')
    // Strip leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Collapse multiple hyphens
    .replace(/-{2,}/g, '-')
    // Length cap
    .slice(0, 64);
}

/**
 * Returns suggestion strings whose displayName contains the query text
 * (case-insensitive, minimum 1 character query).
 */
export function filterClientSuggestions(query: string): KnownClient[] {
  if (!query.trim()) return [];
  const q = query.trim().toLowerCase();
  return KNOWN_CLIENTS.filter(c => c.displayName.toLowerCase().includes(q));
}
