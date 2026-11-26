import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import app from '../src/app.js';
import { pool, query } from '../src/db.js';
import { normalizeAnswer } from '../src/services/game.js';

const TAG = `zzz-${crypto.randomUUID().slice(0, 8)}`; // tout ce que le test crée porte ce préfixe
const TARGET_TITLE = `${TAG} Secret Target`;
const CHAR_NAME = 'Monkey D. Luffy';

let auth;
let target;
const others = [];
let mangaPuzzle;
let charPuzzle;

const png = () => sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#888' } }).png().toBuffer();
const newPlayer = () => crypto.randomUUID();
const admin = (method, url) => request(app)[method](url).set(auth);
const guess = (id, p, payload) => request(app).post(`/api/puzzles/${id}/guess`).send({ playerId: p, ...payload });
const skip = (id, p) => request(app).post(`/api/puzzles/${id}/skip`).send({ playerId: p });

before(async () => {
  const { body } = await request(app).post('/api/admin/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  auth = { Authorization: `Bearer ${body.token}` };

  target = (await admin('post', '/api/admin/mangas')
    .send({ title: TARGET_TITLE, titleNative: 'ひみつ', titleEnglish: `${TAG} Secret EN`, aliases: [`${TAG} alias`] }).expect(201)).body;
  for (let i = 2; i <= 8; i++) others.push((await admin('post', '/api/admin/mangas').send({ title: `${TAG} Other ${i}` }).expect(201)).body);

  // puzzle manga : 6 cases + image de révélation, publié
  mangaPuzzle = (await admin('post', '/api/admin/puzzles').send({ mode: 'manga', mangaId: target.id }).expect(201)).body;
  const img = await png();
  for (let pos = 1; pos <= 6; pos++) {
    await admin('post', `/api/admin/puzzles/${mangaPuzzle.id}/frames`).field('position', pos).attach('image', img, 'a.png').expect(201);
  }
  await admin('post', `/api/admin/puzzles/${mangaPuzzle.id}/answer-image`).attach('image', img, 'a.png').expect(200);
  await admin('put', `/api/admin/puzzles/${mangaPuzzle.id}`).send({ published: true }).expect(200);

  // puzzle personnage : 1 image, réponse libre
  charPuzzle = (await admin('post', '/api/admin/puzzles')
    .send({ mode: 'character', mangaId: target.id, answerName: CHAR_NAME, answerAliases: ['Luffy'] }).expect(201)).body;
  await admin('post', `/api/admin/puzzles/${charPuzzle.id}/frames`).field('position', 1).attach('image', img, 'a.png').expect(201);
  await admin('put', `/api/admin/puzzles/${charPuzzle.id}`).send({ published: true }).expect(200);
});

after(async () => {
  for (const p of [mangaPuzzle, charPuzzle]) if (p) await admin('delete', `/api/admin/puzzles/${p.id}`);
  await query("DELETE FROM puzzles WHERE manga_id IN (SELECT id FROM mangas WHERE title LIKE $1)", [`${TAG}%`]);
  const { rows } = await query('SELECT id FROM mangas WHERE title LIKE $1', [`${TAG}%`]);
  for (const r of rows) await admin('delete', `/api/admin/mangas/${r.id}`);
  await pool.end();
});

test('liste publique : les deux puzzles publiés, sans fuite de réponse', async () => {
  const { body } = await request(app).get('/api/puzzles').expect(200);
  const ids = body.map((p) => p.id);
  assert.ok(ids.includes(mangaPuzzle.id) && ids.includes(charPuzzle.id));
  assert.ok(!JSON.stringify(body).includes(TARGET_TITLE));
  assert.ok(!JSON.stringify(body).includes('Luffy'));
});

test('un brouillon n’est pas jouable ; publier sans case est refusé', async () => {
  const draft = (await admin('post', '/api/admin/puzzles').send({ mode: 'manga', mangaId: target.id }).expect(201)).body;
  assert.equal(draft.published, false);
  await request(app).get(`/api/puzzles/${draft.id}`).expect(404);
  await admin('put', `/api/admin/puzzles/${draft.id}`).send({ published: true }).expect(400);
  await admin('delete', `/api/admin/puzzles/${draft.id}`).expect(204);
});

test('mode manga : une case au départ, rien ne fuite', async () => {
  const res = await request(app).get(`/api/puzzles/${mangaPuzzle.id}?playerId=${newPlayer()}`).expect(200);
  assert.equal(res.body.mode, 'manga');
  assert.equal(res.body.status, 'playing');
  assert.equal(res.body.frames.length, 1);
  assert.equal(res.body.frameCount, 6);
  assert.equal(res.body.answer, null);
  assert.ok(!JSON.stringify(res.body).includes(TARGET_TITLE));
});

test('mode manga : skip et mauvais essai débloquent une case', async () => {
  const p = newPlayer();
  let res = await skip(mangaPuzzle.id, p).expect(200);
  assert.equal(res.body.frames.length, 2);
  res = await guess(mangaPuzzle.id, p, { mangaId: others[0].id }).expect(200);
  assert.equal(res.body.frames.length, 3);
  assert.equal(res.body.guesses[1].manga.id, others[0].id);
  assert.equal(res.body.answer, null);
});

test('mode manga : victoire et écran de révélation', async () => {
  const p = newPlayer();
  const res = await guess(mangaPuzzle.id, p, { mangaId: target.id }).expect(200);
  assert.equal(res.body.status, 'won');
  assert.equal(res.body.frames.length, 6);
  assert.equal(res.body.answer.title, TARGET_TITLE);
  assert.equal(res.body.answer.titleNative, 'ひみつ');
  assert.equal(res.body.answer.titleEnglish, `${TAG} Secret EN`);
  assert.match(res.body.answer.imageUrl, /^\/uploads\/answers\/[0-9a-f-]+\.webp$/);
  await request(app).get(res.body.answer.imageUrl).expect(200);
  await guess(mangaPuzzle.id, p, { mangaId: others[0].id }).expect(409);
  const stats = await request(app).get(`/api/puzzles/${mangaPuzzle.id}/stats`).expect(200);
  assert.equal(stats.body.distribution['1'], 1);
});

test('mode manga : défaite après 6 essais', async () => {
  const p = newPlayer();
  await skip(mangaPuzzle.id, p);
  for (let i = 0; i < 4; i++) await guess(mangaPuzzle.id, p, { mangaId: others[i].id }).expect(200);
  const res = await guess(mangaPuzzle.id, p, { mangaId: others[4].id }).expect(200);
  assert.equal(res.body.status, 'lost');
  assert.equal(res.body.answer.title, TARGET_TITLE);
});

test('mode manga : doublon refusé sans consommer d’essai', async () => {
  const p = newPlayer();
  await guess(mangaPuzzle.id, p, { mangaId: others[0].id }).expect(200);
  await guess(mangaPuzzle.id, p, { mangaId: others[0].id }).expect(400);
  const res = await request(app).get(`/api/puzzles/${mangaPuzzle.id}?playerId=${p}`);
  assert.equal(res.body.guesses.length, 1);
});

test('une nouvelle session repart de zéro', async () => {
  const p = newPlayer();
  await skip(mangaPuzzle.id, p).expect(200);
  const fresh = await request(app).get(`/api/puzzles/${mangaPuzzle.id}?playerId=${newPlayer()}`).expect(200);
  assert.equal(fresh.body.guesses.length, 0);
  assert.equal(fresh.body.frames.length, 1);
});

test('normalisation des réponses libres', () => {
  assert.equal(normalizeAnswer('  Monkey D. Luffy '), 'monkey d luffy');
  assert.equal(normalizeAnswer('ÉDOUARD'), 'edouard');
  assert.equal(normalizeAnswer('ルフィ'), 'ルフィ');
});

test('mode personnage : réponse libre, alias, abandon', async () => {
  let p = newPlayer();
  let res = await request(app).get(`/api/puzzles/${charPuzzle.id}?playerId=${p}`).expect(200);
  assert.equal(res.body.mode, 'character');
  assert.equal(res.body.frames.length, 1);
  assert.ok(!JSON.stringify(res.body).includes('Luffy'));

  res = await guess(charPuzzle.id, p, { text: 'Zoro' }).expect(200);
  assert.equal(res.body.status, 'playing');
  assert.deepEqual(res.body.guesses[0], { type: 'guess', text: 'Zoro', correct: false });
  await guess(charPuzzle.id, p, { text: 'zoro!' }).expect(400); // doublon après normalisation
  await guess(charPuzzle.id, p, { text: '  ' }).expect(400);
  res = await guess(charPuzzle.id, p, { text: 'monkey d luffy' }).expect(200);
  assert.equal(res.body.status, 'won');
  assert.equal(res.body.answer.name, CHAR_NAME);
  assert.equal(res.body.answer.title, TARGET_TITLE);

  p = newPlayer();
  res = await guess(charPuzzle.id, p, { text: 'LUFFY' }).expect(200);
  assert.equal(res.body.status, 'won');

  p = newPlayer();
  res = await skip(charPuzzle.id, p).expect(200);
  assert.equal(res.body.status, 'lost');
  assert.equal(res.body.answer.name, CHAR_NAME);
});

test('mode personnage : une seule image autorisée, nom obligatoire', async () => {
  await admin('post', `/api/admin/puzzles/${charPuzzle.id}/frames`).field('position', 2).attach('image', await png(), 'a.png').expect(400);
  await admin('post', '/api/admin/puzzles').send({ mode: 'character' }).expect(400);
  await admin('post', '/api/admin/puzzles').send({ mode: 'manga' }).expect(400);
  await admin('post', '/api/admin/puzzles').send({ mode: 'autre' }).expect(400);
});

test('puzzle du jour désactivé', async () => {
  await request(app).get('/api/puzzles/today').expect(404);
});

test('validations', async () => {
  await skip(mangaPuzzle.id, 'nope').expect(400);
  await guess(mangaPuzzle.id, newPlayer(), { mangaId: 999999999 }).expect(400);
  await request(app).get('/api/puzzles/99999999').expect(404);
  await request(app).get(`/api/puzzles/${mangaPuzzle.id}?playerId=nope`).expect(400);
});

test('recherche sur titres et alias', async () => {
  let res = await request(app).get(`/api/mangas/search?q=${TAG} other`).expect(200);
  assert.ok(res.body.length >= 7);
  res = await request(app).get(`/api/mangas/search?q=${TAG} alias`).expect(200);
  assert.equal(res.body[0].id, target.id);
});

test('admin : auth, mangas, couverture, suppression protégée', async () => {
  await request(app).get('/api/admin/puzzles').expect(401);
  await request(app).post('/api/admin/login').send({ password: 'bad' }).expect(401);
  await admin('post', '/api/admin/mangas').send({ title: ' ' }).expect(400);
  await admin('post', '/api/admin/mangas').send({ title: `${TAG} x`, year: 3000 }).expect(400);

  const m = (await admin('put', `/api/admin/mangas/${others[6].id}`).send({ titleEnglish: 'Renamed', year: 2001 }).expect(200)).body;
  assert.equal(m.titleEnglish, 'Renamed');
  const withCover = (await admin('post', `/api/admin/mangas/${m.id}/cover`).attach('image', await png(), 'a.png').expect(200)).body;
  assert.match(withCover.coverUrl, /^\/uploads\/covers\//);
  assert.equal((await sharp((await request(app).get(withCover.coverUrl).expect(200)).body).metadata()).width, 600);

  await admin('delete', `/api/admin/mangas/${target.id}`).expect(409); // utilisé par des puzzles
  await admin('delete', `/api/admin/mangas/${m.id}`).expect(204);
  others.pop();
});

test('admin : cases (WebP), réordonnancement, ordre des puzzles', async () => {
  const detail = (await admin('get', `/api/admin/puzzles/${mangaPuzzle.id}`).expect(200)).body;
  const file = await request(app).get(detail.frames[0].url).expect(200);
  assert.equal(file.headers['content-type'], 'image/webp');
  assert.equal((await sharp(file.body).metadata()).width, 1000);

  const reversed = detail.frames.map((f) => f.id).reverse();
  const order = await admin('put', `/api/admin/puzzles/${mangaPuzzle.id}/frames/order`).send({ frameIds: reversed }).expect(200);
  assert.deepEqual(order.body.map((f) => f.id), reversed);
  await admin('post', `/api/admin/puzzles/${mangaPuzzle.id}/frames`).field('position', 1).attach('image', Buffer.from('pas une image'), 'x.png').expect(400);

  const all = (await admin('get', '/api/admin/puzzles').expect(200)).body.filter((p) => p.mode === 'manga').map((p) => p.id);
  const moved = [mangaPuzzle.id, ...all.filter((i) => i !== mangaPuzzle.id)];
  await admin('put', '/api/admin/puzzles/order').send({ mode: 'manga', ids: moved }).expect(200);
  const pub = (await request(app).get('/api/puzzles')).body.filter((p) => p.mode === 'manga');
  assert.equal(pub[0].id, mangaPuzzle.id);
  assert.equal(pub[0].number, 1);
  await admin('put', '/api/admin/puzzles/order').send({ mode: 'manga', ids: moved.slice(1) }).expect(400);
});
