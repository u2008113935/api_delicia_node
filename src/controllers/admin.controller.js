// Mantenimientos del ADMIN: personal y combos del ML
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { ErrorApi, idValido, requerir } from '../utils/errores.js';

const PUBLICO = 'id, nombre, correo, rol, telefono, direccion, activo, creado_en';

// GET /api/admin/usuarios?rol=EMPLEADO
export async function listarUsuarios(req, res) {
  const { rol } = req.query;
  const { rows } = rol
    ? await query(`SELECT ${PUBLICO} FROM usuarios WHERE rol = $1 ORDER BY nombre`, [rol])
    : await query(`SELECT ${PUBLICO} FROM usuarios ORDER BY rol, nombre`);
  res.json(rows);
}

// POST /api/admin/usuarios   body: { nombre, correo, password, rol: "EMPLEADO" | "ADMIN", telefono }
export async function crearUsuario(req, res) {
  requerir(req.body, ['nombre', 'correo', 'password', 'rol']);
  const { nombre, correo, password, rol, telefono = null } = req.body;
  if (!['EMPLEADO', 'ADMIN'].includes(rol)) throw new ErrorApi(400, 'Rol debe ser EMPLEADO o ADMIN');
  if (password.length < 8) throw new ErrorApi(400, 'La contraseña debe tener al menos 8 caracteres');
  try {
    const { rows } = await query(
      `INSERT INTO usuarios (nombre, correo, password_hash, rol, telefono)
       VALUES ($1, LOWER($2), $3, $4, $5) RETURNING ${PUBLICO}`,
      [nombre, correo, await bcrypt.hash(password, 10), rol, telefono]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new ErrorApi(409, 'Ese correo ya está registrado');
    throw e;
  }
}

// PUT /api/admin/usuarios/:id   body: { nombre, telefono, activo, password }  (solo lo que llega)
export async function editarUsuario(req, res) {
  const id = idValido(req.params.id);
  if (id === req.usuario.id && req.body.activo === false) {
    throw new ErrorApi(400, 'No puedes desactivar tu propia cuenta');
  }
  const { nombre, telefono, direccion, activo, password } = req.body;
  if (password && password.length < 8) throw new ErrorApi(400, 'La contraseña debe tener al menos 8 caracteres');
  const { rows } = await query(
    `UPDATE usuarios SET
        nombre        = COALESCE($1, nombre),
        telefono      = COALESCE($2, telefono),
        direccion     = COALESCE($3, direccion),
        activo        = COALESCE($4, activo),
        password_hash = COALESCE($5, password_hash)
      WHERE id = $6 RETURNING ${PUBLICO}`,
    [nombre, telefono, direccion, activo, password ? await bcrypt.hash(password, 10) : null, id]
  );
  if (!rows.length) throw new ErrorApi(404, 'Usuario no encontrado');
  res.json(rows[0]);
}

// GET /api/admin/combos
export async function listarCombos(_req, res) {
  const { rows } = await query(
    `SELECT c.*, a.nombre AS producto, b.nombre AS producto_sugerido
       FROM ml.combo_sugerido c
       JOIN productos a ON a.id = c.producto_id
       JOIN productos b ON b.id = c.producto_sugerido_id
      ORDER BY c.aprobado, c.lift DESC`
  );
  res.json(rows);
}

// PATCH /api/admin/combos/:id   body: { aprobado, descuento_pct, vigente_hasta }
export async function decidirCombo(req, res) {
  const { aprobado, descuento_pct, vigente_hasta } = req.body;
  if (descuento_pct !== undefined && (descuento_pct < 0 || descuento_pct > 50)) {
    throw new ErrorApi(400, 'El descuento debe estar entre 0 y 50 %');
  }
  const { rows } = await query(
    `UPDATE ml.combo_sugerido SET
        aprobado      = COALESCE($1, aprobado),
        descuento_pct = COALESCE($2, descuento_pct),
        vigente_hasta = COALESCE($3, vigente_hasta)
      WHERE id = $4 RETURNING *`,
    [aprobado, descuento_pct, vigente_hasta, idValido(req.params.id)]
  );
  if (!rows.length) throw new ErrorApi(404, 'Combo no encontrado');
  res.json(rows[0]);
}