/**
 * Seed de démo : catalogue AniList, puzzles passés / du jour / à venir,
 * fausses cases façon planche manga (avec indices progressifs) et fausses parties.
 *
 *   npm run seed:demo                       # complète sans rien écraser
 *   npm run seed:demo -- --reset            # repart de zéro (puzzles, parties, images)
 *   npm run seed:demo -- --past=30 --future=14 --seed=42
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { pool, query, withTransaction } from '../src/db.js';
import { framesDir, FRAME_COUNT, MAX_ATTEMPTS } from '../src/config.js';
import { importFromAniList } from '../src/services/anilist.js';
import { setFrame, getFrames } from '../src/services/puzzles.js';
import { todayParis } from '../src/utils.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const PAST = parseInt(args.past, 10) || 21;
const FUTURE = parseInt(args.future, 10) || 10;
const SEED = parseInt(args.seed, 10) || 1234;
const MIN_MANGAS = 200;

// ---------- aléatoire déterministe ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (...xs) => xs.reduce((h, x) => Math.imul(h ^ (typeof x === 'number' ? x : [...String(x)].reduce((s, c) => s * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0, SEED);
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, a, b) => a + r() * (b - a);

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// ---------- fausses cases ----------
const W = 1000;
const H = 625;
const SFX = ['ドン!', 'ゴゴゴ', 'バン!', 'ザッ', 'シーン…', 'ドキッ', 'BOOM', 'WHOOSH', 'KRAK!', 'SHHH…'];
const LINES = ['…', '!?', 'Impossible…', 'Tu ne comprends pas.', 'On y va !', 'Encore toi ?!', 'C\'est maintenant ou jamais.', 'Je ne reculerai pas.'];

/** Indice révélé à la case n : de plus en plus précis. */
function clueFor(n, manga, r) {
  const decade = manga.year ? `${Math.floor(manga.year / 10) * 10}s` : 'années ?';
  const initials = (manga.author || '?').split(/\s+/).map((w) => `${w[0]}.`).join(' ');
  const masked = manga.title.replace(/[A-Za-z0-9]/g, (c, i) => (i === 0 || manga.title[i - 1] === ' ' ? c : '_'));
  switch (n) {
    case 1: return pick(r, LINES);
    case 2: return pick(r, LINES);
    case 3: return `Début : ${decade}`;
    case 4: return `Auteur : ${initials}`;
    case 5: return `Paru en ${manga.year ?? '?'}`;
    default: return masked.length > 28 ? `${masked.slice(0, 27)}…` : masked;
  }
}

function panelSvg(n, manga, r) {
  const ink = '#111';
  const cx = between(r, 250, 750);
  const cy = between(r, 200, 430);
  const parts = [];

  // trame (screentone)
  parts.push(`<defs>
    <pattern id="tone" width="${8 + Math.floor(r() * 6)}" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <circle cx="3" cy="3" r="${between(r, 1.2, 2.4).toFixed(1)}" fill="${ink}" opacity="0.55"/>
    </pattern>
    <radialGradient id="fade"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#f6f3ea"/>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#tone)" opacity="${between(r, 0.35, 0.8).toFixed(2)}"/>`);

  // lignes de vitesse / concentration
  const style = Math.floor(r() * 3);
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + r() * 0.05;
    const r0 = between(r, 140, 260);
    const w = between(r, 1, 6);
    if (style === 0) {
      parts.push(`<line x1="${cx + Math.cos(a) * r0}" y1="${cy + Math.sin(a) * r0}" x2="${cx + Math.cos(a) * 900}" y2="${cy + Math.sin(a) * 900}" stroke="${ink}" stroke-width="${w.toFixed(1)}"/>`);
    } else if (style === 1) {
      const y = between(r, 0, H);
      parts.push(`<line x1="${between(r, -50, 400)}" y1="${y}" x2="${between(r, 600, 1050)}" y2="${y}" stroke="${ink}" stroke-width="${(w / 2).toFixed(1)}"/>`);
    }
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="260" fill="url(#fade)"/>`);

  // silhouette : tête + épaules + yeux
  const s = between(r, 0.8, 1.3);
  parts.push(`<g transform="translate(${cx} ${cy + 60}) scale(${s.toFixed(2)})" stroke="${ink}" stroke-width="5">
    <path d="M-170 260 Q-150 120 0 110 Q150 120 170 260 Z" fill="${ink}"/>
    <ellipse cx="0" cy="-10" rx="95" ry="115" fill="#fff"/>
    <path d="M-100 -40 L-80 -150 L-40 -95 L-10 -170 L20 -100 L60 -160 L75 -90 L110 -120 L95 -30 Q0 -90 -100 -40 Z" fill="${ink}"/>
    <path d="M-55 0 Q-35 -20 -15 0 Q-35 15 -55 0 Z" fill="${ink}"/>
    <path d="M15 0 Q35 -20 55 0 Q35 15 15 0 Z" fill="${ink}"/>
    <path d="M-20 60 Q0 ${70 + r() * 15} 20 60" fill="none"/>
  </g>`);

  // onomatopée
  const sfx = pick(r, SFX);
  parts.push(`<text x="${between(r, 60, 260)}" y="${between(r, 120, 560)}" transform="rotate(${between(r, -18, 18).toFixed(0)})" font-family="Noto Sans CJK JP, Montserrat, sans-serif" font-weight="900" font-size="${Math.floor(between(r, 70, 110))}" fill="#fff" stroke="${ink}" stroke-width="6" paint-order="stroke">${esc(sfx)}</text>`);

  // bulle avec l'indice
  const clue = clueFor(n, manga, r);
  const fs = clue.length > 20 ? 34 : 42;
  const bw = Math.min(560, Math.max(220, clue.length * fs * 0.6 + 80));
  const bx = cx > 500 ? 40 : W - bw - 40;
  const by = 30;
  parts.push(`<g>
    <ellipse cx="${bx + bw / 2}" cy="${by + 70}" rx="${bw / 2}" ry="70" fill="#fff" stroke="${ink}" stroke-width="5"/>
    <path d="M${bx + bw / 2 - 30} ${by + 128} L${(bx + bw / 2 + cx) / 2} ${(by + 140 + cy - 120) / 2 + 20} L${bx + bw / 2 + 30} ${by + 128} Z" fill="#fff" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>
    <ellipse cx="${bx + bw / 2}" cy="${by + 70}" rx="${bw / 2 - 4}" ry="66" fill="#fff"/>
    <text x="${bx + bw / 2}" y="${by + 70 + fs / 3}" text-anchor="middle" font-family="Montserrat, sans-serif" font-weight="700" font-size="${fs}" fill="${ink}">${esc(clue)}</text>
  </g>`);

  // cadre + marqueurs
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="none" stroke="${ink}" stroke-width="12"/>`);
  parts.push(`<text x="${W - 30}" y="${H - 28}" text-anchor="end" font-family="Montserrat, sans-serif" font-weight="800" font-size="26" fill="${ink}" opacity="0.6">DÉMO · ${n}/6</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

const fakePanel = (n, manga, puzzleId) => sharp(Buffer.from(panelSvg(n, manga, rng(hash(puzzleId, n))))).png().toBuffer();

// ---------- fausses parties ----------
// probabilité de trouver à l'essai k (sinon perdu)
const WIN_AT = [0.08, 0.14, 0.18, 0.17, 0.13, 0.1];

function fakePlay(r, answerId, pool) {
  const guesses = [];
  let roll = r();
  let winAt = null;
  for (let k = 0; k < MAX_ATTEMPTS; k++) {
    if (roll < WIN_AT[k]) { winAt = k + 1; break; }
    roll -= WIN_AT[k];
  }
  const total = winAt ?? MAX_ATTEMPTS;
  const used = new Set([answerId]);
  for (let k = 1; k <= total; k++) {
    if (k === winAt) { guesses.push({ type: 'guess', mangaId: answerId, correct: true }); break; }
    if (r() < 0.2) { guesses.push({ type: 'skip', correct: false }); continue; }
    let id;
    do id = pick(r, pool); while (used.has(id));
    used.add(id);
    guesses.push({ type: 'guess', mangaId: id, correct: false });
  }
  return { guesses, status: winAt ? 'won' : 'lost', attempts: guesses.length };
}

// ---------- main ----------
async function main() {
  const today = todayParis();
  const r = rng(SEED);

  if (args.reset) {
    const { rows } = await query('SELECT filename FROM frames');
    await query('DELETE FROM plays');
    await query('DELETE FROM puzzles');
    await Promise.all(rows.map((f) => fs.rm(path.join(framesDir, f.filename), { force: true })));
    console.log(`Reset : puzzles, parties et ${rows.length} images supprimés`);
  }

  const { rows: [{ n: mangaCount }] } = await query('SELECT count(*)::int AS n FROM mangas');
  if (mangaCount < MIN_MANGAS) {
    console.log('Import AniList…');
    console.log(`  ${await importFromAniList(Math.ceil(MIN_MANGAS / 50))} mangas importés`);
  }
  const { rows: catalogue } = await query('SELECT * FROM mangas ORDER BY popularity DESC');
  const allIds = catalogue.map((m) => m.id);
  const top = catalogue.slice(0, 120);

  // puzzles : J-PAST → J+FUTURE
  const { rows: existing } = await query('SELECT id, date, manga_id FROM puzzles');
  const used = new Set(existing.map((p) => p.manga_id));
  const byDate = new Map(existing.map((p) => [p.date, p]));
  let created = 0;
  for (let d = -PAST; d <= FUTURE; d++) {
    const date = addDays(today, d);
    if (byDate.has(date)) continue;
    const candidates = top.filter((m) => !used.has(m.id));
    const manga = pick(r, candidates.length ? candidates : top);
    used.add(manga.id);
    const { rows: [p] } = await query('INSERT INTO puzzles (date, manga_id) VALUES ($1, $2) RETURNING id, date, manga_id', [date, manga.id]);
    byDate.set(date, p);
    created++;
  }
  console.log(`${created} puzzles créés`);

  // cases manquantes
  const mangaById = new Map(catalogue.map((m) => [m.id, m]));
  let images = 0;
  for (const p of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const have = new Set((await getFrames(p.id)).map((f) => f.position));
    for (let n = 1; n <= FRAME_COUNT; n++) {
      if (have.has(n)) continue;
      await setFrame(p.id, n, await fakePanel(n, mangaById.get(p.manga_id), p.id));
      images++;
    }
  }
  console.log(`${images} cases générées`);

  // parties sur les puzzles publiés
  let plays = 0;
  for (const p of byDate.values()) {
    if (p.date > today) continue;
    const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM plays WHERE puzzle_id = $1', [p.id]);
    if (n >= 10) continue;
    const age = Math.round((new Date(today) - new Date(p.date)) / 864e5);
    const count = Math.floor(between(r, 40, 220) * (age === 0 ? 0.4 : 1));
    await withTransaction(async (c) => {
      for (let i = 0; i < count; i++) {
        const g = fakePlay(r, p.manga_id, allIds);
        const at = new Date(`${p.date}T${String(6 + Math.floor(r() * 17)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00+01:00`);
        await c.query(
          'INSERT INTO plays (puzzle_id, player_id, guesses, status, attempts, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [p.id, crypto.randomUUID(), JSON.stringify(g.guesses), g.status, g.attempts, at]);
      }
    });
    plays += count;
  }
  console.log(`${plays} fausses parties créées`);

  const { rows: summary } = await query(
    `SELECT p.date, m.title, (SELECT count(*) FROM frames f WHERE f.puzzle_id = p.id)::int AS frames,
            (SELECT count(*) FROM plays pl WHERE pl.puzzle_id = p.id)::int AS plays
     FROM puzzles p JOIN mangas m ON m.id = p.manga_id ORDER BY p.date`);
  console.table(summary.map((s) => ({ ...s, '': s.date === today ? '← aujourd\'hui' : '' })));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
