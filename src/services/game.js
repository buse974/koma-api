import { query, withTransaction } from '../db.js';
import { MAX_ATTEMPTS } from '../config.js';
import { HttpError, UUID_RE } from '../utils.js';
import { toManga, toAnswer, getManga } from './mangas.js';
import { findPlayable, listPlayable, getFrames, toMeta } from './puzzles.js';
import { frameUrl } from './uploads.js';

export function assertPlayerId(playerId) {
  if (typeof playerId !== 'string' || !UUID_RE.test(playerId)) throw new HttpError(400, 'playerId invalide (UUID attendu)');
  return playerId.toLowerCase();
}

const optionalPlayerId = (playerId) => (playerId === undefined ? null : assertPlayerId(playerId));

/**
 * Construit le GameState. Les cases non débloquées et la réponse
 * ne quittent jamais le serveur tant que la partie est en cours.
 */
async function buildState(puzzle, play, db = { query }) {
  const guesses = play?.guesses ?? [];
  const status = play?.status ?? 'playing';
  const finished = status !== 'playing';

  const ids = guesses.filter((g) => g.type === 'guess').map((g) => g.mangaId);
  const { rows: mangaRows } = ids.length
    ? await db.query('SELECT * FROM mangas WHERE id = ANY($1)', [ids])
    : { rows: [] };
  const byId = new Map(mangaRows.map((m) => [m.id, m]));

  const unlocked = finished ? puzzle.frame_count : Math.min(guesses.length + 1, MAX_ATTEMPTS);
  const frames = (await getFrames(puzzle.id)).slice(0, unlocked).map((f) => frameUrl(f.filename));

  return {
    ...toMeta(puzzle),
    status,
    maxAttempts: MAX_ATTEMPTS,
    guesses: guesses.map((g) =>
      g.type === 'skip'
        ? { type: 'skip', correct: false }
        : { type: 'guess', manga: toAnswer(byId.get(g.mangaId)), correct: g.correct }),
    frames,
    answer: finished ? toAnswer(await getManga(puzzle.manga_id)) : null
  };
}

async function getPlay(puzzleId, playerId) {
  if (!playerId) return null;
  const { rows } = await query('SELECT * FROM plays WHERE puzzle_id = $1 AND player_id = $2', [puzzleId, playerId]);
  return rows[0] || null;
}

async function requirePlayable(number) {
  const puzzle = await findPlayable({ number });
  if (!puzzle) throw new HttpError(404, 'Puzzle introuvable');
  return puzzle;
}

export async function getToday(playerId) {
  const pid = optionalPlayerId(playerId);
  const puzzle = await findPlayable({ today: true });
  if (!puzzle) throw new HttpError(404, "Aucun puzzle aujourd'hui");
  return buildState(puzzle, await getPlay(puzzle.id, pid));
}

export async function getByNumber(number, playerId) {
  const pid = optionalPlayerId(playerId);
  const puzzle = await requirePlayable(number);
  return buildState(puzzle, await getPlay(puzzle.id, pid));
}

export async function listForPlayer(playerId) {
  const pid = optionalPlayerId(playerId);
  const puzzles = await listPlayable();
  const statuses = new Map();
  if (pid) {
    const { rows } = await query('SELECT puzzle_id, status FROM plays WHERE player_id = $1', [pid]);
    rows.forEach((r) => statuses.set(r.puzzle_id, r.status));
  }
  return puzzles.map((p) => ({ ...toMeta(p), status: statuses.get(p.id) ?? 'new' }));
}

/** Enregistre un essai (guess ou skip) de façon atomique. */
async function play(number, playerId, makeEntry) {
  const pid = assertPlayerId(playerId);
  const puzzle = await requirePlayable(number);

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
    const status = entry.correct ? 'won' : guesses.length >= MAX_ATTEMPTS ? 'lost' : 'playing';
    const updated = await client.query(
      'UPDATE plays SET guesses = $1, status = $2, attempts = $3 WHERE id = $4 RETURNING *',
      [JSON.stringify(guesses), status, guesses.length, current.id]
    );
    return buildState(puzzle, updated.rows[0], client);
  });
}

export function guess(number, playerId, mangaId) {
  return play(number, playerId, async (puzzle, previous, client) => {
    if (!Number.isInteger(mangaId)) throw new HttpError(400, 'mangaId invalide');
    const { rows } = await client.query('SELECT id FROM mangas WHERE id = $1', [mangaId]);
    if (!rows[0]) throw new HttpError(400, 'Manga introuvable');
    if (previous.some((g) => g.type === 'guess' && g.mangaId === mangaId)) {
      throw new HttpError(400, 'Ce manga a déjà été proposé');
    }
    return { type: 'guess', mangaId, correct: mangaId === puzzle.manga_id };
  });
}

export const skip = (number, playerId) =>
  play(number, playerId, async () => ({ type: 'skip', correct: false }));

export async function getStats(number) {
  const puzzle = await requirePlayable(number);
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
