import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { requireAdmin, signAdminToken } from '../middleware/auth.js';
import * as puzzles from '../services/puzzles.js';
import { importFromAniList } from '../services/anilist.js';
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

router.post('/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !req.body?.password || !safeEqual(req.body.password, expected)) {
    throw new HttpError(401, 'Mot de passe incorrect');
  }
  res.json({ token: signAdminToken() });
});

router.use(requireAdmin);

router.get('/puzzles', async (req, res) => res.json(await puzzles.listAdminPuzzles()));
router.get('/puzzles/:id', async (req, res) => res.json(await puzzles.getAdminPuzzle(id(req.params.id))));
router.post('/puzzles', async (req, res) => res.status(201).json(await puzzles.createPuzzle(req.body ?? {})));
router.put('/puzzles/:id', async (req, res) =>
  res.json(await puzzles.updatePuzzle(id(req.params.id), req.body ?? {})));
router.delete('/puzzles/:id', async (req, res) => {
  await puzzles.deletePuzzle(id(req.params.id));
  res.status(204).end();
});

router.post('/puzzles/:id/frames', upload.single('image'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Champ "image" manquant');
  res.status(201).json(await puzzles.setFrame(id(req.params.id), parseInt(req.body?.position, 10), req.file.buffer));
});
// déclarée avant /frames/:position
router.put('/puzzles/:id/frames/order', async (req, res) =>
  res.json(await puzzles.reorderFrames(id(req.params.id), req.body?.frameIds)));
router.delete('/puzzles/:id/frames/:position', async (req, res) => {
  await puzzles.deleteFrame(id(req.params.id), id(req.params.position));
  res.status(204).end();
});

router.get('/calendar', async (req, res) => res.json(await puzzles.getCalendar()));

router.post('/mangas/import', async (req, res) => {
  const pages = req.body?.pages === undefined ? 40 : parseInt(req.body.pages, 10);
  if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw new HttpError(400, 'pages doit être entre 1 et 200');
  res.json({ imported: await importFromAniList(pages) });
});

export default router;
