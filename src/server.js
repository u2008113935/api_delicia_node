import app from './app.js';

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env');
  process.exit(1);
}

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`API Delicia escuchando en http://localhost:${PORT}/api`));