import 'dotenv/config';
import path from 'node:path';

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
export const framesDir = path.join(uploadDir, 'frames');
export const MAX_ATTEMPTS = 6;
export const FRAME_COUNT = 6;
