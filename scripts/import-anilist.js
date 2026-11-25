import { pool } from '../src/db.js';
import { importFromAniList } from '../src/services/anilist.js';

const pages = parseInt(process.argv[2], 10) || 40;
importFromAniList(pages)
  .then((n) => console.log(`${n} mangas importés`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
