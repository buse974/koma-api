import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { uploadDir } from '../config.js';
import { HttpError } from '../utils.js';

/** Types d'images stockées : sous-dossier et largeur max. */
const KINDS = {
  frames: 1000, // cases des puzzles
  answers: 1600, // image de l'écran de révélation
  covers: 600 // couvertures des mangas
};

const dirOf = (kind) => {
  if (!KINDS[kind]) throw new Error(`type d'image inconnu : ${kind}`);
  return path.join(uploadDir, kind);
};

export const imageUrl = (kind, filename) => (filename ? `/uploads/${kind}/${filename}` : null);
export const frameUrl = (filename) => imageUrl('frames', filename);

export async function ensureUploadDirs() {
  await Promise.all(Object.keys(KINDS).map((k) => fs.mkdir(dirOf(k), { recursive: true })));
}

/** Convertit une image en WebP (q80) et la stocke. Retourne le nom du fichier. */
export async function saveImage(kind, buffer) {
  let out;
  try {
    out = await sharp(buffer).rotate().resize({ width: KINDS[kind], withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  } catch {
    throw new HttpError(400, 'Image invalide');
  }
  await fs.mkdir(dirOf(kind), { recursive: true });
  const filename = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(dirOf(kind), filename), out);
  return filename;
}

export async function deleteImages(kind, filenames) {
  await Promise.all(filenames.filter(Boolean)
    .map((f) => fs.rm(path.join(dirOf(kind), path.basename(f)), { force: true })));
}
