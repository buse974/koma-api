import { query, withTransaction } from '../db.js';
import { FRAME_COUNT } from '../config.js';
import { HttpError, todayParis, isValidDate } from '../utils.js';
import { toManga, getManga } from './mangas.js';
import { saveFrameImage, deleteFrameFiles, frameUrl } from './uploads.js';

// `number` = rang par date, calculé à la lecture
const NUMBERED = `
  SELECT p.id, p.date, p.manga_id,
         ROW_NUMBER() OVER (ORDER BY p.date)::int AS number,
         (SELECT count(*) FROM frames f WHERE f.puzzle_id = p.id)::int AS frame_count
  FROM puzzles p`;

export const toMeta = (p) => ({ id: p.id, number: p.number, date: p.date });

/** Puzzle jouable : 6 cases et date <= aujourd'hui. */
export async function findPlayable({ number, today }) {
  const { rows } = await query(
    `SELECT * FROM (${NUMBERED}) x
     WHERE frame_count = ${FRAME_COUNT} AND date <= $1 AND ($2::int IS NULL OR number = $2)
     ORDER BY date DESC LIMIT 1`,
    [todayParis(), number ?? null]
  );
  if (today && rows[0]?.date !== todayParis()) return null;
  return rows[0] || null;
}

export async function listPlayable() {
  const { rows } = await query(
    `SELECT * FROM (${NUMBERED}) x WHERE frame_count = ${FRAME_COUNT} AND date <= $1 ORDER BY date DESC`,
    [todayParis()]
  );
  return rows;
}

export async function getFrames(puzzleId) {
  const { rows } = await query('SELECT id, position, filename FROM frames WHERE puzzle_id = $1 ORDER BY position', [puzzleId]);
  return rows;
}

// ---------- Admin ----------

async function toAdminPuzzle(p) {
  const [manga, frames] = await Promise.all([getManga(p.manga_id), getFrames(p.id)]);
  return {
    ...toMeta(p),
    manga: toManga(manga),
    frames: frames.map((f) => ({ id: f.id, position: f.position, url: frameUrl(f.filename) }))
  };
}

async function findById(id) {
  const { rows } = await query(`SELECT * FROM (${NUMBERED}) x WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Puzzle introuvable');
  return rows[0];
}

export async function listAdminPuzzles() {
  const { rows } = await query(`SELECT * FROM (${NUMBERED}) x ORDER BY date`);
  return Promise.all(rows.map(toAdminPuzzle));
}

export const getAdminPuzzle = async (id) => toAdminPuzzle(await findById(id));

function checkFutureDate(date) {
  if (!isValidDate(date)) throw new HttpError(400, 'Date invalide (YYYY-MM-DD attendu)');
  if (date < todayParis()) throw new HttpError(400, 'La date ne peut pas être dans le passé');
}

async function checkManga(mangaId) {
  if (!Number.isInteger(mangaId) || !(await getManga(mangaId))) throw new HttpError(400, 'Manga introuvable');
}

const isUniqueViolation = (err) => err.code === '23505';

export async function createPuzzle({ mangaId, date }) {
  checkFutureDate(date);
  await checkManga(mangaId);
  try {
    const { rows } = await query('INSERT INTO puzzles (date, manga_id) VALUES ($1, $2) RETURNING id', [date, mangaId]);
    return getAdminPuzzle(rows[0].id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'Un puzzle existe déjà à cette date');
    throw err;
  }
}

export async function updatePuzzle(id, { mangaId, date }) {
  const current = await findById(id);
  if (mangaId !== undefined && mangaId !== current.manga_id) {
    await checkManga(mangaId);
    // les parties déjà jouées ont été jugées sur l'ancienne réponse
    if (current.date <= todayParis()) throw new HttpError(400, 'Le manga d\'un puzzle déjà publié ne peut pas être changé');
  }
  if (date !== undefined && date !== current.date) {
    checkFutureDate(date);
    // déplacer un puzzle déjà passé décalerait la numérotation
    if (current.date < todayParis()) throw new HttpError(400, 'Un puzzle passé ne peut pas être déplacé');
  }
  try {
    await query('UPDATE puzzles SET manga_id = COALESCE($2, manga_id), date = COALESCE($3, date) WHERE id = $1',
      [id, mangaId ?? null, date ?? null]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'Un puzzle existe déjà à cette date');
    throw err;
  }
  return getAdminPuzzle(id);
}

export async function deletePuzzle(id) {
  await findById(id);
  const frames = await getFrames(id);
  await query('DELETE FROM puzzles WHERE id = $1', [id]);
  await deleteFrameFiles(frames.map((f) => f.filename));
}

/** Ajoute ou remplace la case à `position`. */
export async function setFrame(puzzleId, position, buffer) {
  if (!Number.isInteger(position) || position < 1 || position > FRAME_COUNT) {
    throw new HttpError(400, `position doit être entre 1 et ${FRAME_COUNT}`);
  }
  await findById(puzzleId);
  const filename = await saveFrameImage(buffer);
  try {
    const { frame, old } = await withTransaction(async (c) => {
      const prev = await c.query('SELECT id, filename FROM frames WHERE puzzle_id = $1 AND position = $2 FOR UPDATE', [puzzleId, position]);
      const res = prev.rows[0]
        ? await c.query('UPDATE frames SET filename = $2 WHERE id = $1 RETURNING id, position, filename', [prev.rows[0].id, filename])
        : await c.query('INSERT INTO frames (puzzle_id, position, filename) VALUES ($1,$2,$3) RETURNING id, position, filename', [puzzleId, position, filename]);
      return { frame: res.rows[0], old: prev.rows[0]?.filename };
    });
    if (old) await deleteFrameFiles([old]);
    return { id: frame.id, position: frame.position, url: frameUrl(frame.filename) };
  } catch (err) {
    await deleteFrameFiles([filename]);
    throw err;
  }
}

export async function deleteFrame(puzzleId, position) {
  await findById(puzzleId);
  const { rows } = await query('DELETE FROM frames WHERE puzzle_id = $1 AND position = $2 RETURNING filename', [puzzleId, position]);
  if (!rows[0]) throw new HttpError(404, 'Case introuvable');
  await deleteFrameFiles([rows[0].filename]);
}

export async function reorderFrames(puzzleId, frameIds) {
  await findById(puzzleId);
  const frames = await getFrames(puzzleId);
  const valid = Array.isArray(frameIds) && frameIds.length === FRAME_COUNT
    && new Set(frameIds).size === FRAME_COUNT
    && frameIds.every((fid) => frames.some((f) => f.id === fid));
  if (!valid) throw new HttpError(400, `frameIds doit contenir les ${FRAME_COUNT} ids des cases du puzzle`);
  await withTransaction(async (c) => {
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [i, fid] of frameIds.entries()) {
      await c.query('UPDATE frames SET position = $1 WHERE id = $2', [i + 1, fid]);
    }
  });
  return (await getAdminPuzzle(puzzleId)).frames;
}

/** Combien de jours à venir (aujourd'hui inclus) ont un puzzle complet d'affilée. */
export async function getCalendar() {
  const today = todayParis();
  const { rows } = await query(
    `SELECT date FROM (${NUMBERED}) x WHERE frame_count = ${FRAME_COUNT} AND date >= $1`, [today]);
  const ready = new Set(rows.map((r) => r.date));
  let day = today;
  let scheduledAhead = 0;
  while (ready.has(day)) {
    scheduledAhead++;
    day = addDays(day, 1);
  }
  return { today, scheduledAhead, nextEmptyDate: day, alert: scheduledAhead < 7 };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
