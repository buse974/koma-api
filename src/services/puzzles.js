import { query, withTransaction } from '../db.js';
import { MAX_FRAMES, MODES } from '../config.js';
import { HttpError, todayParis } from '../utils.js';
import { toAdminManga, getManga } from './mangas.js';
import { saveImage, deleteImages, frameUrl, imageUrl } from './uploads.js';

/**
 * Un puzzle est « prêt » quand il a sa réponse et au moins une case
 * (exactement une en mode personnage). Il est jouable s'il est prêt ET publié.
 * `number` = rang dans l'ordre manuel, par mode, parmi les puzzles jouables.
 */
const WITH_COUNTS = `
  SELECT p.*, (SELECT count(*) FROM frames f WHERE f.puzzle_id = p.id)::int AS frame_count
  FROM puzzles p`;
const READY = `(frame_count >= 1 AND (mode = 'manga' OR frame_count = 1))`;
const PLAYABLE = `
  SELECT x.*, ROW_NUMBER() OVER (PARTITION BY mode ORDER BY position, id)::int AS number
  FROM (${WITH_COUNTS}) x WHERE published AND ${READY}`;

export const toMeta = (p) => ({ id: p.id, number: p.number, mode: p.mode });

export async function findPlayable(id) {
  const { rows } = await query(`SELECT * FROM (${PLAYABLE}) y WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Liste publique, dans l'ordre choisi par l'admin. */
export async function listPlayable() {
  const { rows } = await query(`SELECT * FROM (${PLAYABLE}) y ORDER BY (mode = 'manga') DESC, position, id`);
  return rows;
}

/**
 * Mode quotidien (désactivé, cf. DAILY_ENABLED) : puzzle jouable dont la date est aujourd'hui.
 * Conservé pour être réactivé plus tard.
 */
export async function findToday() {
  const { rows } = await query(`SELECT * FROM (${PLAYABLE}) y WHERE date = $1 ORDER BY mode LIMIT 1`, [todayParis()]);
  return rows[0] || null;
}

export async function getFrames(puzzleId) {
  const { rows } = await query('SELECT id, position, filename FROM frames WHERE puzzle_id = $1 ORDER BY position', [puzzleId]);
  return rows;
}

// ---------- Admin ----------

async function toAdminPuzzle(p) {
  const [manga, frames] = await Promise.all([p.manga_id ? getManga(p.manga_id) : null, getFrames(p.id)]);
  const ready = frames.length >= 1 && (p.mode === 'manga' || frames.length === 1);
  return {
    id: p.id,
    mode: p.mode,
    position: p.position,
    published: p.published,
    ready,
    maxFrames: MAX_FRAMES[p.mode],
    manga: manga ? toAdminManga(manga) : null,
    answerName: p.answer_name,
    answerAliases: p.answer_aliases,
    answerImageUrl: imageUrl('answers', p.answer_image),
    frames: frames.map((f) => ({ id: f.id, position: f.position, url: frameUrl(f.filename) }))
  };
}

async function findById(id, db = { query }) {
  const { rows } = await db.query('SELECT * FROM puzzles WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Puzzle introuvable');
  return rows[0];
}

export async function listAdminPuzzles() {
  const { rows } = await query("SELECT * FROM puzzles ORDER BY (mode = 'manga') DESC, position, id");
  return Promise.all(rows.map(toAdminPuzzle));
}

export const getAdminPuzzle = async (id) => toAdminPuzzle(await findById(id));

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Champs modifiables, validés. `mode` sert à savoir ce qui est obligatoire. */
async function parseFields(body, mode, partial) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (has('mangaId') || (!partial && mode === 'manga')) {
    if (body.mangaId === null && mode === 'character') out.manga_id = null;
    else {
      if (!Number.isInteger(body.mangaId) || !(await getManga(body.mangaId))) throw new HttpError(400, 'Manga introuvable');
      out.manga_id = body.mangaId;
    }
  }
  if (has('answerName') || (!partial && mode === 'character')) {
    out.answer_name = str(body.answerName);
    if (mode === 'character' && !out.answer_name) throw new HttpError(400, 'Le nom du personnage est obligatoire');
  }
  if (has('answerAliases')) {
    if (!Array.isArray(body.answerAliases)) throw new HttpError(400, 'answerAliases doit être une liste');
    out.answer_aliases = [...new Set(body.answerAliases.map(str).filter(Boolean))];
  }
  if (has('published')) {
    if (typeof body.published !== 'boolean') throw new HttpError(400, 'published doit être un booléen');
    out.published = body.published;
  }
  return out;
}

export async function createPuzzle(body) {
  const mode = body.mode ?? 'manga';
  if (!MODES.includes(mode)) throw new HttpError(400, `mode doit être ${MODES.join(' ou ')}`);
  const f = { ...(await parseFields(body, mode, false)), published: false };
  const cols = ['mode', ...Object.keys(f)];
  const values = [mode, ...Object.values(f)];
  // nouveau puzzle : en fin de liste de son mode
  const { rows } = await query(
    `INSERT INTO puzzles (${cols.join(', ')}, position)
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')},
             (SELECT COALESCE(max(position), 0) + 1 FROM puzzles WHERE mode = $1))
     RETURNING id`,
    values
  );
  return getAdminPuzzle(rows[0].id);
}

export async function updatePuzzle(id, body) {
  const current = await findById(id);
  const f = await parseFields(body, current.mode, true);
  if (f.published) {
    const p = await toAdminPuzzle({ ...current, ...f });
    if (!p.ready) {
      throw new HttpError(400, current.mode === 'character'
        ? 'Ajoute l’image du personnage avant de publier'
        : 'Ajoute au moins une case avant de publier');
    }
  }
  const cols = Object.keys(f);
  if (cols.length) {
    await query(`UPDATE puzzles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...Object.values(f)]);
  }
  return getAdminPuzzle(id);
}

export async function deletePuzzle(id) {
  const p = await findById(id);
  const frames = await getFrames(id);
  await query('DELETE FROM puzzles WHERE id = $1', [id]);
  await deleteImages('frames', frames.map((f) => f.filename));
  await deleteImages('answers', [p.answer_image]);
}

/** Range les puzzles d'un mode dans l'ordre donné (liste complète des ids du mode). */
export async function reorderPuzzles(mode, ids) {
  if (!MODES.includes(mode)) throw new HttpError(400, 'mode invalide');
  const { rows } = await query('SELECT id FROM puzzles WHERE mode = $1', [mode]);
  const all = new Set(rows.map((r) => r.id));
  const valid = Array.isArray(ids) && ids.length === all.size && new Set(ids).size === ids.length && ids.every((i) => all.has(i));
  if (!valid) throw new HttpError(400, 'ids doit contenir tous les puzzles du mode, une fois chacun');
  await withTransaction(async (c) => {
    for (const [i, pid] of ids.entries()) await c.query('UPDATE puzzles SET position = $1 WHERE id = $2', [i + 1, pid]);
  });
  return listAdminPuzzles();
}

// ---------- Images ----------

/** Ajoute ou remplace la case à `position`. */
export async function setFrame(puzzleId, position, buffer) {
  const p = await findById(puzzleId);
  const max = MAX_FRAMES[p.mode];
  if (!Number.isInteger(position) || position < 1 || position > max) {
    throw new HttpError(400, `position doit être entre 1 et ${max}`);
  }
  const filename = await saveImage('frames', buffer);
  try {
    const { frame, old } = await withTransaction(async (c) => {
      const prev = await c.query('SELECT id, filename FROM frames WHERE puzzle_id = $1 AND position = $2 FOR UPDATE', [puzzleId, position]);
      const res = prev.rows[0]
        ? await c.query('UPDATE frames SET filename = $2 WHERE id = $1 RETURNING id, position, filename', [prev.rows[0].id, filename])
        : await c.query('INSERT INTO frames (puzzle_id, position, filename) VALUES ($1,$2,$3) RETURNING id, position, filename', [puzzleId, position, filename]);
      return { frame: res.rows[0], old: prev.rows[0]?.filename };
    });
    if (old) await deleteImages('frames', [old]);
    return { id: frame.id, position: frame.position, url: frameUrl(frame.filename) };
  } catch (err) {
    await deleteImages('frames', [filename]);
    throw err;
  }
}

/** Supprime une case ; un puzzle qui n'a plus de case est dépublié. */
export async function deleteFrame(puzzleId, position) {
  await findById(puzzleId);
  const { rows } = await query('DELETE FROM frames WHERE puzzle_id = $1 AND position = $2 RETURNING filename', [puzzleId, position]);
  if (!rows[0]) throw new HttpError(404, 'Case introuvable');
  await deleteImages('frames', [rows[0].filename]);
  await query('UPDATE puzzles SET published = false WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM frames WHERE puzzle_id = $1)', [puzzleId]);
}

/** Réordonne les cases : `frameIds` = tous les ids des cases du puzzle, dans le nouvel ordre. */
export async function reorderFrames(puzzleId, frameIds) {
  await findById(puzzleId);
  const frames = await getFrames(puzzleId);
  const valid = Array.isArray(frameIds) && frameIds.length === frames.length
    && new Set(frameIds).size === frames.length
    && frameIds.every((fid) => frames.some((f) => f.id === fid));
  if (!valid) throw new HttpError(400, 'frameIds doit contenir tous les ids des cases du puzzle');
  await withTransaction(async (c) => {
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [i, fid] of frameIds.entries()) {
      await c.query('UPDATE frames SET position = $1 WHERE id = $2', [i + 1, fid]);
    }
  });
  return (await getAdminPuzzle(puzzleId)).frames;
}

export async function setAnswerImage(puzzleId, buffer) {
  const p = await findById(puzzleId);
  const filename = await saveImage('answers', buffer);
  await query('UPDATE puzzles SET answer_image = $2 WHERE id = $1', [puzzleId, filename]);
  await deleteImages('answers', [p.answer_image]);
  return getAdminPuzzle(puzzleId);
}

export async function removeAnswerImage(puzzleId) {
  const p = await findById(puzzleId);
  await query('UPDATE puzzles SET answer_image = NULL WHERE id = $1', [puzzleId]);
  await deleteImages('answers', [p.answer_image]);
  return getAdminPuzzle(puzzleId);
}
