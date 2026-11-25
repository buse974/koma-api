import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import multer from 'multer';
import { uploadDir, framesDir } from './config.js';
import swaggerDocument from './swagger.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';

fs.mkdirSync(framesDir, { recursive: true });

const app = express();

app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',').map((o) => o.trim()) }));
app.use(express.json());

app.use('/uploads', express.static(uploadDir, { maxAge: '30d', immutable: true }));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'koma-api', type: 'api' });
});

app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne' });
});

export default app;
