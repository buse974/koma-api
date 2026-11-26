import { query } from '../db.js';
import { HttpError } from '../utils.js';
import { saveImage, deleteImages, imageUrl } from './uploads.js';

/** Version publique (autocomplétion, essais). */
export const toManga = (r) => ({
  id: r.id,
  title: r.title,
  titleNative: r.title_native,
  titleEnglish: r.title_english,
  year: r.year,
  coverUrl: r.cover_url
});

/** Version admin : tous les champs. */
export const toAdminManga = (r) => ({
  ...toManga(r),
  aliases: r.aliases,
  author: r.author,
  link: r.link,
  puzzleCount: r.puzzle_count ?? undefined
});

const buildSearchText = ({ title, title_native: native, title_english: english, aliases }) =>
  [title, native, english, ...(aliases || [])].filter(Boolean).join(' ').toLowerCase();

export async function getManga(id) {
  const { rows } = await query('SELECT * FROM mangas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function requireManga(id) {
  const m = await getManga(id);
  if (!m) throw new HttpError(404, 'Manga introuvable');
  return m;
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
              title
     LIMIT $3`,
    [like, term, n]
  );
  return rows.map(toManga);
}

// ---------- Admin ----------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Valide et normalise les champs envoyés ; `partial` pour une mise à jour. */
function parseFields(body, partial) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) {
    out.title = str(body.title);
    if (!out.title) throw new HttpError(400, 'Le titre est obligatoire');
  }
  if (has('titleNative')) out.title_native = str(body.titleNative);
  if (has('titleEnglish')) out.title_english = str(body.titleEnglish);
  if (has('author')) out.author = str(body.author);
  if (has('link')) {
    out.link = str(body.link);
    if (out.link && !/^https?:\/\//.test(out.link)) throw new HttpError(400, 'Le lien doit commencer par http(s)://');
  }
  if (has('year')) {
    out.year = body.year === null || body.year === '' ? null : Number(body.year);
    if (out.year !== null && !(Number.isInteger(out.year) && out.year >= 1900 && out.year <= 2100)) {
      throw new HttpError(400, 'Année invalide');
    }
  }
  if (has('aliases')) {
    if (!Array.isArray(body.aliases)) throw new HttpError(400, 'aliases doit être une liste');
    out.aliases = [...new Set(body.aliases.map(str).filter(Boolean))];
  }
  return out;
}

export async function listMangas() {
  const { rows } = await query(
    `SELECT m.*, (SELECT count(*) FROM puzzles p WHERE p.manga_id = m.id)::int AS puzzle_count
     FROM mangas m ORDER BY lower(m.title)`);
  return rows.map(toAdminManga);
}

export async function createManga(body) {
  const f = { aliases: [], ...parseFields(body, false) };
  const cols = Object.keys(f);
  const { rows } = await query(
    `INSERT INTO mangas (${cols.join(', ')}, search_text) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1})
     RETURNING *`,
    [...Object.values(f), buildSearchText(f)]
  );
  return toAdminManga(rows[0]);
}

export async function updateManga(id, body) {
  const current = await requireManga(id);
  const f = parseFields(body, true);
  const next = { ...current, ...f };
  const cols = Object.keys(f);
  const { rows } = await query(
    `UPDATE mangas SET ${[...cols, 'search_text'].map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...Object.values(f), buildSearchText(next)]
  );
  return toAdminManga(rows[0]);
}

export async function deleteManga(id) {
  const m = await requireManga(id);
  const { rows } = await query('SELECT count(*)::int AS n FROM puzzles WHERE manga_id = $1', [id]);
  if (rows[0].n > 0) throw new HttpError(409, `Ce manga est utilisé par ${rows[0].n} puzzle(s)`);
  await query('DELETE FROM mangas WHERE id = $1', [id]);
  await deleteImages('covers', [ownCover(m.cover_url)]);
}

/** Nom du fichier si la couverture est un upload local. */
const ownCover = (url) => (url?.startsWith('/uploads/covers/') ? url.split('/').pop() : null);

export async function setCover(id, buffer) {
  const m = await requireManga(id);
  const filename = await saveImage('covers', buffer);
  const { rows } = await query('UPDATE mangas SET cover_url = $2 WHERE id = $1 RETURNING *', [id, imageUrl('covers', filename)]);
  await deleteImages('covers', [ownCover(m.cover_url)]);
  return toAdminManga(rows[0]);
}

export async function removeCover(id) {
  const m = await requireManga(id);
  const { rows } = await query('UPDATE mangas SET cover_url = NULL WHERE id = $1 RETURNING *', [id]);
  await deleteImages('covers', [ownCover(m.cover_url)]);
  return toAdminManga(rows[0]);
}
