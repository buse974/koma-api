import { query } from '../db.js';

export const toManga = (r) => ({
  id: r.id,
  title: r.title,
  titleEnglish: r.title_english,
  year: r.year,
  coverUrl: r.cover_url
});

export const toAnswer = (r) => ({
  ...toManga(r),
  author: r.author,
  anilistUrl: r.anilist_url || (r.anilist_id ? `https://anilist.co/manga/${r.anilist_id}` : null)
});

const buildSearchText = ({ title, titleEnglish, aliases }) =>
  [title, titleEnglish, ...(aliases || [])].filter(Boolean).join(' ').toLowerCase();

/** Insère ou met à jour un manga (clé : anilist_id). */
export async function upsertManga(m, db = { query }) {
  const aliases = [...new Set(m.aliases || [])];
  const { rows } = await db.query(
    `INSERT INTO mangas (anilist_id, title, title_english, aliases, year, cover_url, author, anilist_url, popularity, search_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (anilist_id) DO UPDATE SET
       title = EXCLUDED.title, title_english = EXCLUDED.title_english, aliases = EXCLUDED.aliases,
       year = EXCLUDED.year, cover_url = EXCLUDED.cover_url, author = EXCLUDED.author,
       anilist_url = EXCLUDED.anilist_url, popularity = EXCLUDED.popularity, search_text = EXCLUDED.search_text
     RETURNING *`,
    [m.anilistId, m.title, m.titleEnglish ?? null, aliases, m.year ?? null, m.coverUrl ?? null,
      m.author ?? null, m.anilistUrl ?? null, m.popularity ?? 0, buildSearchText({ ...m, aliases })]
  );
  return rows[0];
}

export async function getManga(id) {
  const { rows } = await query('SELECT * FROM mangas WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function searchMangas(q, limit = 10) {
  const term = String(q || '').trim().toLowerCase();
  if (term.length < 2) return [];
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const like = term.replace(/[\\%_]/g, '\\$&');
  const { rows } = await query(
    `SELECT * FROM mangas
     WHERE search_text LIKE '%' || $1 || '%' OR $2 <% search_text
     ORDER BY (lower(title) LIKE $1 || '%') DESC,
              (search_text LIKE '%' || $1 || '%') DESC,
              word_similarity($2, search_text) DESC,
              popularity DESC
     LIMIT $3`,
    [like, term, n]
  );
  return rows.map(toManga);
}
