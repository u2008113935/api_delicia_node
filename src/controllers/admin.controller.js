import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { firmarToken } from '../middlewares/auth.js';
import { ErrorApi, requerir } from '../utils/errores.js';

const PUBLICO = 'id, nombre, correo, rol, telefono, direccion';

// POST /api/auth/login   body: { correo, password }
// Respuesta = LoginResponse del app: { token, rol, nombre } (+ usuario para la web)
export async function login(req, res) {
  const correo = req.body?.correo ?? req.body?.email;        // la web puede enviar "email"
  requerir({ correo, password: req.body?.password }, ['correo', 'password']);

  const { rows } = await query(
    `SELECT ${PUBLICO}, password_hash, activo FROM usuarios WHERE correo = LOWER($1)`,
    [correo]
  );
  const u = rows[0];
  // Mismo mensaje si no existe o si la clave falla: no revela que correos existen
  if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) {
    throw new ErrorApi(401, 'Correo o contraseña incorrectos');
  }
  if (!u.activo) throw new ErrorApi(403, 'Usuario desactivado. Consulta con el administrador');

  delete u.password_hash;
  delete u.activo;
  res.json({ token: firmarToken(u), rol: u.rol, nombre: u.nombre, usuario: u });
}

// POST /api/auth/registro   (solo crea CLIENTES; el personal lo crea el admin)
export async function registrar(req, res) {
  const correo = req.body?.correo ?? req.body?.email;
  requerir({ ...req.body, correo }, ['nombre', 'correo', 'password', 'telefono']);
  const { nombre, password, telefono, direccion } = req.body;
  if (password.length < 8) throw new ErrorApi(400, 'La contraseña debe tener al menos 8 caracteres');

  try {
    const { rows } = await query(
      `INSERT INTO usuarios (nombre, correo, password_hash, rol, telefono, direccion)
       VALUES ($1, LOWER($2), $3, 'CLIENTE', $4, $5) RETURNING ${PUBLICO}`,
      [nombre, correo, await bcrypt.hash(password, 10), telefono, direccion ?? null]
    );
    const u = rows[0];
    res.status(201).json({ token: firmarToken(u), rol: u.rol, nombre: u.nombre, usuario: u });
  } catch (e) {
    if (e.code === '23505') throw new ErrorApi(409, 'Ese correo ya está registrado');
    throw e;
  }
}

// GET /api/auth/perfil
export async function perfil(req, res) {
  const { rows } = await query(`SELECT ${PUBLICO} FROM usuarios WHERE id = $1`, [req.usuario.id]);
  res.json(rows[0]);
}