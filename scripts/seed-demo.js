import sharp from 'sharp';
import { pool, query } from '../src/db.js';
import { importFromAniList } from '../src/services/anilist.js';
import { createPuzzle, setFrame, getAdminPuzzle } from '../src/services/puzzles.js';
import { todayParis } from '../src/utils.js';

const COLORS = ['#E63946', '#F4A261', '#E9C46A', '#2A9D8F', '#457B9D', '#6D597A'];

const placeholder = (n) =>
  sharp({ create: { width: 1000, height: 625, channels: 3, background: COLORS[n - 1] } })
    .composite([{
      input: Buffer.from(`<svg width="1000" height="625"><text x="500" y="400" font-size="320" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text></svg>`)
    }])
    .png()
    .toBuffer();

async function main() {
  console.log(`${await importFromAniList(1)} mangas importés`);

  const today = todayParis();
  const { rows: existing } = await query('SELECT id FROM puzzles WHERE date = $1', [today]);
  let puzzleId = existing[0]?.id;
  if (!puzzleId) {
    const { rows: [manga] } = await query('SELECT id FROM mangas ORDER BY popularity DESC LIMIT 1');
    puzzleId = (await createPuzzle({ mangaId: manga.id, date: today })).id;
  }
  for (let n = 1; n <= 6; n++) await setFrame(puzzleId, n, await placeholder(n));

  const puzzle = await getAdminPuzzle(puzzleId);
  console.log(`Puzzle #${puzzle.number} du ${puzzle.date} : ${puzzle.manga.title} (${puzzle.frames.length} cases)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
