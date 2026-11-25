import jwt from 'jsonwebtoken';
import { HttpError } from '../utils.js';

export const signAdminToken = () =>
  jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });

export function requireAdmin(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  try {
    if (scheme !== 'Bearer' || !token) throw new Error('missing');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('role');
    next();
  } catch {
    next(new HttpError(401, 'Non autorisé'));
  }
}
