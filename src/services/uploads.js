import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { framesDir } from '../config.js';
import { HttpError } from '../utils.js';

export const frameUrl = (filename) => `/uploads/frames/${filename}`;

/** Convertit une image en WebP (q80, 1000 px max) et la stocke. Retourne le nom du fichier. */
export async function saveFrameImage(buffer) {
  let out;
  try {
    out = await sharp(buffer).rotate().resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  } catch {
    throw new HttpError(400, 'Image invalide');
  }
  await fs.mkdir(framesDir, { recursive: true });
  const filename = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(framesDir, filename), out);
  return filename;
}

export async function deleteFrameFiles(filenames) {
  await Promise.all(filenames.map((f) => fs.rm(path.join(framesDir, path.basename(f)), { force: true })));
}
