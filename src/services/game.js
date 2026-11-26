import { query, withTransaction } from '../db.js';
import { MAX_ATTEMPTS, DAILY_ENABLED } from '../config.js';
import { HttpError, UUID_RE } from '../utils.js';
import { toManga, getManga } from './mangas.js';
import { findPlayable, findToday, listPlayable, getFrames, toMeta } from './puzzles.js';
import { frameUrl, imageUrl } from './uploads.js';

/**
 * `playerId` identifie une session de jeu : le front en tire un nouveau à chaque
 * ouverture d'un puzzle, donc la progression repart de zéro à chaque visite.
 */
export function assertPlayerId(playerId) {
  if (typeof playerId !== 'string' || !UUID_RE.test(playerId)) throw new HttpError(400, 'playerId invalide (UUID attendu)');
  return playerId.toLowerCase();
}

const optionalPlayerId = (playerId) => (playerId === undefined ? null : assertPlayerId(playerId));

/** Minuscules, sans accents ni ponctuation, espaces réduits : « Monkey D. Luffy » → « monkey d luffy ». */
export function normalizeAnswer(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Ce que montre l'écran de révélation. */
async function buildAnswer(puzzle) {
  const manga = puzzle.manga_id ? await getManga(puzzle.manga_id) : null;
  return {
    name: puzzle.mode === 'character' ? puzzle.answer_name : null,
    titleNative: manga?.title_native ?? null,
    title: manga?.title ?? null,
    titleEnglish: manga?.title_english ?? null,
    author: manga?.author ?? null,
    year: manga?.year ?? null,
    link: manga?.link ?? null,
    imageUrl: imageUrl('answers', puzzle.answer_image) ?? manga?.cover_url ?? null
  };
}

/**
 * Construit le GameState. Les cases non débloquées et la réponse
 * ne quittent jamais le serveur tant que la partie est en cours.
 */
async function buildState(puzzle, play, db = { query }) {
  const guesses = play?.guesses ?? [];
  const status = play?.status ?? 'playing';
  const finished = status !== 'playing';

  const ids = guesses.filter((g) => g.mangaId).map((g) => g.mangaId);
  const { rows: mangaRows } = ids.length
    ? await db.query('SELECT * FROM mangas WHERE id = ANY($1)', [ids])
    : { rows: [] };
  const byId = new Map(mangaRows.map((m) => [m.id, m]));

  const all = await getFrames(puzzle.id);
  const unlocked = finished ? all.length : Math.min(guesses.length + 1, all.length);

  return {
    ...toMeta(puzzle),
    status,
    maxAttempts: MAX_ATTEMPTS,
    frameCount: all.length,
    guesses: guesses.map((g) => {
      if (g.type === 'skip') return { type: 'skip', correct: false };
      if (g.mangaId) return { type: 'guess', manga: byId.has(g.mangaId) ? toManga(byId.get(g.mangaId)) : null, correct: g.correct };
      return { type: 'guess', text: g.text, correct: g.correct };
    }),
    frames: all.slice(0, unlocked).map((f) => frameUrl(f.filename)),
    answer: finished ? await buildAnswer(puzzle) : null
  };
}

async function getPlay(puzzleId, playerId) {
  if (!playerId) return null;
  const { rows } = await query('SELECT * FROM plays WHERE puzzle_id = $1 AND player_id = $2', [puzzleId, playerId]);
  return rows[0] || null;
}

async function requirePlayable(id) {
  const puzzle = await findPlayable(id);
  if (!puzzle) throw new HttpError(404, 'Puzzle introuvable');
  return puzzle;
}

/** Mode quotidien : désactivé tant que DAILY_ENABLED n'est pas à true. */
export async function getToday(playerId) {
  if (!DAILY_ENABLED) throw new HttpError(404, 'Le puzzle du jour est désactivé');
  const pid = optionalPlayerId(playerId);
  const puzzle = await findToday();
  if (!puzzle) throw new HttpError(404, "Aucun puzzle aujourd'hui");
  return buildState(puzzle, await getPlay(puzzle.id, pid));
}

export async function getPuzzle(id, playerId) {
  const pid = optionalPlayerId(playerId);
  const puzzle = await requirePlayable(id);
  return buildState(puzzle, await getPlay(puzzle.id, pid));
}

export async function listPuzzles() {
  return (await listPlayable()).map(toMeta);
}

/** Enregistre un essai (guess ou skip) de façon atomique. */
async function play(id, playerId, makeEntry) {
  const pid = assertPlayerId(playerId);
  const puzzle = await requirePlayable(id);

  return withTransaction(async (client) => {
    await client.query(
      'INSERT INTO plays (puzzle_id, player_id) VALUES ($1, $2) ON CONFLICT (puzzle_id, player_id) DO NOTHING',
      [puzzle.id, pid]
    );
    const { rows } = await client.query(
      'SELECT * FROM plays WHERE puzzle_id = $1 AND player_id = $2 FOR UPDATE', [puzzle.id, pid]);
    const current = rows[0];
    if (current.status !== 'playing') throw new HttpError(409, 'Partie terminée');

    const entry = await makeEntry(puzzle, current.guesses, client);
    const guesses = [...current.guesses, entry];
    // en mode personnage, « passer » = abandonner (il n'y a pas d'autre case à révéler)
    const giveUp = entry.type === 'skip' && puzzle.mode === 'character';
    const status = entry.correct ? 'won' : giveUp || guesses.length >= MAX_ATTEMPTS ? 'lost' : 'playing';
    const updated = await client.query(
      'UPDATE plays SET guesses = $1, status = $2, attempts = $3 WHERE id = $4 RETURNING *',
      [JSON.stringify(guesses), status, guesses.length, current.id]
    );
    return buildState(puzzle, updated.rows[0], client);
  });
}

/** Essai : `mangaId` en mode manga, `text` (saisie libre) en mode personnage. */
export function guess(id, playerId, { mangaId, text } = {}) {
  return play(id, playerId, async (puzzle, previous, client) => {
    if (puzzle.mode === 'character') {
      const value = typeof text === 'string' ? text.trim().slice(0, 120) : '';
      const norm = normalizeAnswer(value);
      if (!norm) throw new HttpError(400, 'Réponse vide');
      if (previous.some((g) => g.text && normalizeAnswer(g.text) === norm)) throw new HttpError(400, 'Réponse déjà proposée');
      const accepted = [puzzle.answer_name, ...(puzzle.answer_aliases || [])].map(normalizeAnswer);
      return { type: 'guess', text: value, correct: accepted.includes(norm) };
    }
    if (!Number.isInteger(mangaId)) throw new HttpError(400, 'mangaId invalide');
    const { rows } = await client.query('SELECT id FROM mangas WHERE id = $1', [mangaId]);
    if (!rows[0]) throw new HttpError(400, 'Manga introuvable');
    if (previous.some((g) => g.mangaId === mangaId)) throw new HttpError(400, 'Ce manga a déjà été proposé');
    return { type: 'guess', mangaId, correct: mangaId === puzzle.manga_id };
  });
}

export const skip = (id, playerId) =>
  play(id, playerId, async () => ({ type: 'skip', correct: false }));

export async function getStats(id) {
  const puzzle = await requirePlayable(id);
  const { rows } = await query(
    `SELECT status, attempts, count(*)::int AS n FROM plays
     WHERE puzzle_id = $1 AND status <> 'playing' GROUP BY status, attempts`, [puzzle.id]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, lost: 0 };
  let plays = 0;
  let wins = 0;
  for (const r of rows) {
    plays += r.n;
    if (r.status === 'won') { wins += r.n; distribution[r.attempts] += r.n; }
    else distribution.lost += r.n;
  }
  return { plays, wins, distribution };
}
