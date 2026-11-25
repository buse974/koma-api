import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import app from '../src/app.js';
import { pool, query } from '../src/db.js';
import { upsertManga } from '../src/services/mangas.js';

const PAST = '1999-01-01'; // dates passées insérées en SQL (l'admin les refuse)
const FUTURE = '2099-01-01';
const TARGET_TITLE = 'Zzz Secret Target Title';

let target;
const others = [];
let number;
const frameFiles = [];

const newPlayer = () => crypto.randomUUID();
const guess = (p, mangaId) => request(app).post(`/api/puzzles/${number}/guess`).send({ playerId: p, mangaId });
const skip = (p) => request(app).post(`/api/puzzles/${number}/skip`).send({ playerId: p });

before(async () => {
  target = await upsertManga({ anilistId: -1, title: TARGET_TITLE, aliases: ['Zzz alias'] });
  for (let i = 2; i <= 8; i++) others.push(await upsertManga({ anilistId: -i, title: `Zzz Other ${i}` }));
  const { rows: [puzzle] } = await query('INSERT INTO puzzles (date, manga_id) VALUES ($1,$2) RETURNING id', [PAST, target.id]);
  for (let pos = 1; pos <= 6; pos++) {
    const file = `test-${crypto.randomUUID()}.webp`;
    frameFiles.push(file);
    await query('INSERT INTO frames (puzzle_id, position, filename) VALUES ($1,$2,$3)', [puzzle.id, pos, file]);
  }
  const list = await request(app).get('/api/puzzles');
  number = list.body.find((p) => p.date === PAST).number;
});

after(async () => {
  await query('DELETE FROM puzzles WHERE date IN ($1,$2)', [PAST, FUTURE]);
  await query('DELETE FROM mangas WHERE anilist_id < 0');
  await pool.end();
});

test('partie en cours : une seule case, pas de réponse, rien ne fuite', async () => {
  const p = newPlayer();
  const res = await request(app).get(`/api/puzzles/${number}?playerId=${p}`).expect(200);
  assert.equal(res.body.status, 'playing');
  assert.equal(res.body.frames.length, 1);
  assert.equal(res.body.answer, null);
  const raw = JSON.stringify(res.body) + JSON.stringify((await request(app).get(`/api/puzzles?playerId=${p}`)).body);
  assert.ok(!raw.includes(TARGET_TITLE));
  assert.ok(!raw.includes(frameFiles[1]));
});

test('skip et mauvais essai débloquent une case, sans fuite', async () => {
  const p = newPlayer();
  let res = await skip(p).expect(200);
  assert.equal(res.body.frames.length, 2);
  assert.deepEqual(res.body.guesses, [{ type: 'skip', correct: false }]);
  res = await guess(p, others[0].id).expect(200);
  assert.equal(res.body.frames.length, 3);
  assert.equal(res.body.guesses[1].manga.id, others[0].id);
  assert.equal(res.body.answer, null);
  assert.ok(!JSON.stringify(res.body).includes(TARGET_TITLE));
});

test('victoire : 6 cases et réponse', async () => {
  const p = newPlayer();
  const res = await guess(p, target.id).expect(200);
  assert.equal(res.body.status, 'won');
  assert.equal(res.body.frames.length, 6);
  assert.equal(res.body.answer.title, TARGET_TITLE);
  await guess(p, others[0].id).expect(409);
  const stats = await request(app).get(`/api/puzzles/${number}/stats`).expect(200);
  assert.equal(stats.body.wins, 1);
  assert.equal(stats.body.distribution['1'], 1);
});

test('défaite après 6 essais ratés (skips compris)', async () => {
  const p = newPlayer();
  await skip(p);
  await skip(p);
  for (let i = 0; i < 3; i++) await guess(p, others[i].id).expect(200);
  const res = await guess(p, others[3].id).expect(200);
  assert.equal(res.body.status, 'lost');
  assert.equal(res.body.frames.length, 6);
  assert.equal(res.body.answer.id, target.id);
  const stats = await request(app).get(`/api/puzzles/${number}/stats`);
  assert.equal(stats.body.distribution.lost, 1);
});

test('doublon refusé sans consommer d’essai', async () => {
  const p = newPlayer();
  await guess(p, others[0].id).expect(200);
  await guess(p, others[0].id).expect(400);
  const res = await request(app).get(`/api/puzzles/${number}?playerId=${p}`);
  assert.equal(res.body.guesses.length, 1);
});

test('validations', async () => {
  await request(app).post(`/api/puzzles/${number}/skip`).send({ playerId: 'nope' }).expect(400);
  await guess(newPlayer(), 999999999).expect(400);
  await request(app).get('/api/puzzles/99999').expect(404);
  await request(app).get(`/api/puzzles/${number}?playerId=nope`).expect(400);
});

test('recherche sur titre et alias', async () => {
  let res = await request(app).get('/api/mangas/search?q=zzz other').expect(200);
  assert.ok(res.body.length >= 7);
  res = await request(app).get('/api/mangas/search?q=zzz alias').expect(200);
  assert.equal(res.body[0].id, target.id);
});

test('admin : auth, date passée refusée, upload, réordonnancement', async () => {
  await request(app).get('/api/admin/puzzles').expect(401);
  await request(app).post('/api/admin/login').send({ password: 'bad' }).expect(401);
  const { body: { token } } = await request(app).post('/api/admin/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const auth = { Authorization: `Bearer ${token}` };

  await request(app).post('/api/admin/puzzles').set(auth).send({ mangaId: target.id, date: PAST }).expect(400);
  const created = await request(app).post('/api/admin/puzzles').set(auth).send({ mangaId: target.id, date: FUTURE }).expect(201);
  await request(app).post('/api/admin/puzzles').set(auth).send({ mangaId: target.id, date: FUTURE }).expect(409);
  await request(app).put(`/api/admin/puzzles/${created.body.id}`).set(auth).send({ date: PAST }).expect(400);

  const png = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#888' } }).png().toBuffer();
  const ids = [];
  for (let pos = 1; pos <= 6; pos++) {
    const r = await request(app).post(`/api/admin/puzzles/${created.body.id}/frames`).set(auth)
      .field('position', pos).attach('image', png, 'a.png').expect(201);
    assert.match(r.body.url, /^\/uploads\/frames\/[0-9a-f-]+\.webp$/);
    ids.push(r.body.id);
  }
  const detail = await request(app).get(`/api/admin/puzzles/${created.body.id}`).set(auth).expect(200);
  const file = await request(app).get(detail.body.frames[0].url).expect(200);
  assert.equal(file.headers['content-type'], 'image/webp');
  assert.equal((await sharp(file.body).metadata()).width, 1000);

  const reversed = [...ids].reverse();
  const order = await request(app).put(`/api/admin/puzzles/${created.body.id}/frames/order`).set(auth).send({ frameIds: reversed }).expect(200);
  assert.deepEqual(order.body.map((f) => f.id), reversed);
  await request(app).post(`/api/admin/puzzles/${created.body.id}/frames`).set(auth)
    .field('position', 1).attach('image', Buffer.from('pas une image'), 'x.png').expect(400);
  await request(app).delete(`/api/admin/puzzles/${created.body.id}`).set(auth).expect(204);
});
