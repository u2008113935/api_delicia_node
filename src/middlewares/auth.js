// Seguridad: el token JWT dice quien es el usuario y que rol tiene.
// Roles en MAYUSCULAS, igual que el enum Rol del app: ADMIN, EMPLEADO, CLIENTE
import jwt from 'jsonwebtoken';
import { ErrorApi } from '../utils/errores.js';
import { query } from '../config/db.js';

export function firmarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, rol: usuario.rol, nombre: usuario.nombre },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRA || '8h' }
  );
}

async function leerToken(req) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) return null;
  let usuario;
  try {
    usuario = jwt.verify(token, process.env.JWT_SECRET);   // { id, rol, nombre }
  } catch {
    throw new ErrorApi(401, 'Token inválido o vencido');
  }
  // Si el admin desactivo al usuario, pierde acceso al instante
  const { rows } = await query('SELECT activo FROM usuarios WHERE id = $1', [usuario.id]);
  if (!rows[0]?.activo) throw new ErrorApi(401, 'Usuario desactivado');
  return usuario;
}

// Exige el encabezado: Authorization: Bearer <token>
export async function verificarToken(req, _res, next) {
  req.usuario = await leerToken(req);
  if (!req.usuario) throw new ErrorApi(401, 'Falta el token');
  next();
}

// Si hay token lo lee; si no, sigue como visitante (catalogo publico)
export async function tokenOpcional(req, _res, next) {
  req.usuario = await leerToken(req);
  next();
}

// Uso: permitirRoles('EMPLEADO', 'ADMIN')
export const permitirRoles = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.usuario?.rol)) throw new ErrorApi(403, 'No tienes permiso para esta acción');
  next();
};