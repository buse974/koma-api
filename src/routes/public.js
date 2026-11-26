import { Router } from 'express';
import * as game from '../services/game.js';
import { searchMangas } from '../services/mangas.js';
import { HttpError } from '../utils.js';

const router = Router();

const id = (raw) => {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'Puzzle introuvable');
  return parseInt(raw, 10);
};

// mode quotidien : désactivé (404) tant que DAILY_ENABLED n'est pas à true
router.get('/puzzles/today', async (req, res) => res.json(await game.getToday(req.query.playerId)));
router.get('/puzzles', async (req, res) => res.json(await game.listPuzzles()));
router.get('/puzzles/:id', async (req, res) => res.json(await game.getPuzzle(id(req.params.id), req.query.playerId)));
router.post('/puzzles/:id/guess', async (req, res) =>
  res.json(await game.guess(id(req.params.id), req.body?.playerId, { mangaId: req.body?.mangaId, text: req.body?.text })));
router.post('/puzzles/:id/skip', async (req, res) =>
  res.json(await game.skip(id(req.params.id), req.body?.playerId)));
router.get('/puzzles/:id/stats', async (req, res) => res.json(await game.getStats(id(req.params.id))));

router.get('/mangas/search', async (req, res) =>
  res.json(await searchMangas(req.query.q, req.query.limit)));

export default router;
