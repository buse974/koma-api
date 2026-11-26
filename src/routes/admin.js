import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { requireAdmin, signAdminToken } from '../middleware/auth.js';
import * as puzzles from '../services/puzzles.js';
import * as mangas from '../services/mangas.js';
import { HttpError } from '../utils.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const id = (raw) => {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'Introuvable');
  return parseInt(raw, 10);
};

const file = (req) => {
  if (!req.file) throw new HttpError(400, 'Champ "image" manquant');
  return req.file.buffer;
};

router.post('/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !req.body?.password || !safeEqual(req.body.password, expected)) {
    throw new HttpError(401, 'Mot de passe incorrect');
  }
  res.json({ token: signAdminToken() });
});

router.use(requireAdmin);

// ---------- Puzzles ----------
router.get('/puzzles', async (req, res) => res.json(await puzzles.listAdminPuzzles()));
// déclarée avant /puzzles/:id
router.put('/puzzles/order', async (req, res) => res.json(await puzzles.reorderPuzzles(req.body?.mode, req.body?.ids)));
router.get('/puzzles/:id', async (req, res) => res.json(await puzzles.getAdminPuzzle(id(req.params.id))));
router.post('/puzzles', async (req, res) => res.status(201).json(await puzzles.createPuzzle(req.body ?? {})));
router.put('/puzzles/:id', async (req, res) => res.json(await puzzles.updatePuzzle(id(req.params.id), req.body ?? {})));
router.delete('/puzzles/:id', async (req, res) => {
  await puzzles.deletePuzzle(id(req.params.id));
  res.status(204).end();
});

router.post('/puzzles/:id/frames', upload.single('image'), async (req, res) =>
  res.status(201).json(await puzzles.setFrame(id(req.params.id), parseInt(req.body?.position, 10), file(req))));
// déclarée avant /frames/:position
router.put('/puzzles/:id/frames/order', async (req, res) =>
  res.json(await puzzles.reorderFrames(id(req.params.id), req.body?.frameIds)));
router.delete('/puzzles/:id/frames/:position', async (req, res) => {
  await puzzles.deleteFrame(id(req.params.id), id(req.params.position));
  res.status(204).end();
});

router.post('/puzzles/:id/answer-image', upload.single('image'), async (req, res) =>
  res.json(await puzzles.setAnswerImage(id(req.params.id), file(req))));
router.delete('/puzzles/:id/answer-image', async (req, res) =>
  res.json(await puzzles.removeAnswerImage(id(req.params.id))));

// ---------- Mangas ----------
router.get('/mangas', async (req, res) => res.json(await mangas.listMangas()));
router.post('/mangas', async (req, res) => res.status(201).json(await mangas.createManga(req.body ?? {})));
router.put('/mangas/:id', async (req, res) => res.json(await mangas.updateManga(id(req.params.id), req.body ?? {})));
router.delete('/mangas/:id', async (req, res) => {
  await mangas.deleteManga(id(req.params.id));
  res.status(204).end();
});
router.post('/mangas/:id/cover', upload.single('image'), async (req, res) =>
  res.json(await mangas.setCover(id(req.params.id), file(req))));
router.delete('/mangas/:id/cover', async (req, res) => res.json(await mangas.removeCover(id(req.params.id))));

export default router;
