/**
 * Recherche en direct dans l'API publique d'AniList (GraphQL, sans clé).
 * Limite AniList : ~90 requêtes/min par IP → cache mémoire + pause après un 429.
 * En cas d'échec, renvoie null : l'appelant se rabat sur la base locale.
 */
const ENDPOINT = 'https://graphql.anilist.co';
const TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 1000;

const QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: MANGA, countryOfOrigin: JP, sort: [SEARCH_MATCH, POPULARITY_DESC], isAdult: false) {
      id siteUrl
      title { romaji english native }
      synonyms
      startDate { year }
      coverImage { large }
      staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
    }
  }
}`;

export const liveSearchEnabled = () => process.env.ANILIST_SEARCH !== 'off';

const cache = new Map(); // clé → { at, value }
let pausedUntil = 0;

/** Media AniList → champs de la table mangas. */
export function fromAniList(media) {
  const edges = media.staff?.edges || [];
  const author = (edges.find((e) => /story/i.test(e.role)) || edges[0])?.node.name.full ?? null;
  const { romaji, english, native } = media.title;
  return {
    anilist_id: media.id,
    title: romaji || english || native,
    title_native: native ?? null,
    title_english: english && english !== romaji ? english : null,
    aliases: [...new Set((media.synonyms || []).filter(Boolean))],
    year: media.startDate?.year ?? null,
    cover_url: media.coverImage?.large ?? null,
    author,
    link: media.siteUrl ?? `https://anilist.co/manga/${media.id}`
  };
}

/** Résultats AniList pour `term` (null si indisponible). */
export async function searchAniList(term, perPage = 10) {
  if (!liveSearchEnabled() || Date.now() < pausedUntil) return null;
  const key = `${perPage}:${term}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { search: term, perPage } }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 429) {
      pausedUntil = Date.now() + (parseInt(res.headers.get('retry-after'), 10) || 60) * 1000;
      return null;
    }
    if (!res.ok) return null;
    const json = await res.json();
    if (json.errors || !json.data?.Page?.media) return null;
    const value = json.data.Page.media.map(fromAniList);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null; // timeout, réseau…
  }
}

/** Pour les tests. */
export function resetAniListState() {
  cache.clear();
  pausedUntil = 0;
}
