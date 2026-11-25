import { withTransaction } from '../db.js';
import { upsertManga } from './mangas.js';

const ENDPOINT = 'https://graphql.anilist.co';
const PAUSE_MS = 800; // ~75 req/min, sous la limite de 90
const PER_PAGE = 50;

const QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: MANGA, countryOfOrigin: JP, sort: POPULARITY_DESC) {
      id siteUrl popularity
      title { romaji english native }
      synonyms
      startDate { year }
      coverImage { large }
      staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { page, perPage: PER_PAGE } })
  });
  if (res.status === 429 && attempt < 3) {
    const wait = (parseInt(res.headers.get('retry-after'), 10) || 60) * 1000;
    await sleep(wait);
    return fetchPage(page, attempt + 1);
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList : ${json.errors[0].message}`);
  return json.data.Page;
}

function toManga(media) {
  const edges = media.staff?.edges || [];
  const author = (edges.find((e) => /story/i.test(e.role)) || edges[0])?.node.name.full ?? null;
  const { romaji, english, native } = media.title;
  return {
    anilistId: media.id,
    title: romaji || english || native,
    titleEnglish: english && english !== romaji ? english : null,
    aliases: [native, ...(media.synonyms || [])].filter(Boolean),
    year: media.startDate?.year ?? null,
    coverUrl: media.coverImage?.large ?? null,
    author,
    anilistUrl: media.siteUrl,
    popularity: media.popularity ?? 0
  };
}

/** Importe les `pages` premières pages (50 mangas chacune) par popularité. */
export async function importFromAniList(pages = 40) {
  let imported = 0;
  for (let page = 1; page <= pages; page++) {
    const data = await fetchPage(page);
    await withTransaction(async (client) => {
      for (const media of data.media) await upsertManga(toManga(media), client);
    });
    imported += data.media.length;
    if (!data.pageInfo.hasNextPage) break;
    if (page < pages) await sleep(PAUSE_MS);
  }
  return imported;
}
