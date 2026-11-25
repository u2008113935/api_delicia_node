import express from 'express';
import cors from 'cors';
import rutas from './routes/index.js';
import { pool } from './config/db.js';

const app = express();

// Solo las webs de la lista pueden llamar a la API desde el navegador.
// El app Android no usa CORS, por eso no se lista.
const origenes = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: origenes.length ? origenes : true }));
app.use(express.json({ limit: '100kb' }));

// Salud: Render y el docente comprueban que la API y Neon responden
app.get('/api/salud', async (_req, res) => {
  const { rows } = await pool.query('SELECT now() AS hora_bd');
  res.json({ estado: 'ok', hora_bd: rows[0].hora_bd });
});

app.use('/api', rutas);

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Manejador de errores: Express 5 envia aqui los errores de funciones async
app.use((err, _req, res, _next) => {
  if (err.estado) return res.status(err.estado).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON mal formado' });
  if (err.code === '22P02' || err.code === '23514') return res.status(400).json({ error: 'Dato inválido' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

export default app;