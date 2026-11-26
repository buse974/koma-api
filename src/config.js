import 'dotenv/config';
import path from 'node:path';

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
export const MAX_ATTEMPTS = 6;

/** Nombre maximum de cases par mode. */
export const MAX_FRAMES = { manga: 6, character: 1 };
export const MODES = Object.keys(MAX_FRAMES);

/**
 * Mode « puzzle du jour » (colonne `date`, GET /puzzles/today).
 * Désactivé pour l'instant : les puzzles sont rangés à la main. DAILY_ENABLED=true pour le réactiver.
 */
export const DAILY_ENABLED = process.env.DAILY_ENABLED === 'true';
