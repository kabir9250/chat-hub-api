/**
 * Referrer → search-engine parsing (Feature 2.2 groundwork,
 * `12-zendesk-feature-parity-srs.md` §2.2 — "Visitor search engine"/"Visitor
 * search terms" conditions). Pure function, computed at READ time from the
 * existing `Visitor.referrer` raw string (FR-VIS-01, `AttributionService`) —
 * deliberately NOT a schema field: a raw referrer never changes for a given
 * Visitor once captured, so re-deriving this on demand is cheap and avoids
 * storing a second, potentially-stale copy of the same information (same
 * "derive at read time" reasoning `derivePageCategory` already established).
 *
 * Only recognizes the query-param shape each engine actually used at the
 * time this list was compiled (Google/Bing/Yahoo/DuckDuckGo/Yandex/Baidu) —
 * `q`/`p`/`text` vary by engine. An engine not in this list, or a non-search
 * referrer (a direct link, another site), returns `{ engine: null, terms:
 * null }` — this is intentionally conservative rather than guessing.
 */

export interface ReferrerSearchInfo {
  /** A known engine's canonical id (e.g. 'google'), or null if unrecognized/not a search referrer. */
  engine: string | null;
  /** The decoded query string from that engine's query param, or null. */
  terms: string | null;
}

interface SearchEngineRule {
  id: string;
  /** Hostname suffixes that identify this engine (checked against the referrer's hostname). */
  hostSuffixes: string[];
  /** Query-string param this engine's search terms are read from. */
  queryParam: string;
}

// Order matters only in that each hostname is checked against every rule
// until one matches — no engine's hostSuffixes overlap another's, so order
// is not otherwise significant.
const SEARCH_ENGINE_RULES: SearchEngineRule[] = [
  {
    id: 'google',
    hostSuffixes: ['google.com', 'google.co.uk'],
    queryParam: 'q',
  },
  { id: 'bing', hostSuffixes: ['bing.com'], queryParam: 'q' },
  {
    id: 'yahoo',
    hostSuffixes: ['search.yahoo.com', 'yahoo.com'],
    queryParam: 'p',
  },
  { id: 'duckduckgo', hostSuffixes: ['duckduckgo.com'], queryParam: 'q' },
  {
    id: 'yandex',
    hostSuffixes: ['yandex.com', 'yandex.ru'],
    queryParam: 'text',
  },
  { id: 'baidu', hostSuffixes: ['baidu.com'], queryParam: 'wd' },
];

function hostMatches(hostname: string, suffixes: string[]): boolean {
  const host = hostname.replace(/^www\./, '').toLowerCase();
  return suffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * Parses a raw `document.referrer` string (as stored on `Visitor.referrer`)
 * into a known search engine + its query terms, if recognizable. Never
 * throws — an unparseable/empty/non-search referrer just yields nulls.
 */
export function parseReferrerSearch(
  referrer: string | null | undefined,
): ReferrerSearchInfo {
  if (!referrer) {
    return { engine: null, terms: null };
  }

  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return { engine: null, terms: null };
  }

  const rule = SEARCH_ENGINE_RULES.find((r) =>
    hostMatches(url.hostname, r.hostSuffixes),
  );
  if (!rule) {
    return { engine: null, terms: null };
  }

  const rawTerms = url.searchParams.get(rule.queryParam);
  // A recognized search-engine hostname with no query param present (e.g. a
  // bare homepage referrer) is still a known engine — just with no terms.
  return { engine: rule.id, terms: rawTerms ? rawTerms : null };
}
