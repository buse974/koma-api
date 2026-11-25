import { Router } from 'express';
import * as game from '../services/game.js';
import { searchMangas } from '../services/mangas.js';
import { HttpError } from '../utils.js';

const router = Router();

const parseNumber = (raw) => {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'Puzzle introuvable');
  return parseInt(raw, 10);
};

router.get('/puzzles/today', async (req, res) => res.json(await game.getToday(req.query.playerId)));
router.get('/puzzles', async (req, res) => res.json(await game.listForPlayer(req.query.playerId)));
router.get('/puzzles/:number', async (req, res) =>
  res.json(await game.getByNumber(parseNumber(req.params.number), req.query.playerId)));
router.post('/puzzles/:number/guess', async (req, res) =>
  res.json(await game.guess(parseNumber(req.params.number), req.body?.playerId, req.body?.mangaId)));
router.post('/puzzles/:number/skip', async (req, res) =>
  res.json(await game.skip(parseNumber(req.params.number), req.body?.playerId)));
router.get('/puzzles/:number/stats', async (req, res) =>
  res.json(await game.getStats(parseNumber(req.params.number))));

router.get('/mangas/search', async (req, res) =>
  res.json(await searchMangas(req.query.q, req.query.limit)));

export default router;
