// app: ProductoDto(id, nombre, categoria, precio, activo, imagen_url)
import { query } from '../config/db.js';
import { ErrorApi, idValido, requerir } from '../utils/errores.js';

const CAMPOS = 'id, nombre, descripcion, categoria, precio, activo, imagen_url';
const CATEGORIAS = ['TORTAS', 'POSTRES', 'PANES', 'BOCADITOS'];

// GET /api/productos
// Visitante y cliente: solo activos. ADMIN: todos (para poder reactivar).
export async function listar(req, res) {
  const soloActivos = req.usuario?.rol !== 'ADMIN';
  const { rows } = await query(
    `SELECT ${CAMPOS} FROM productos ${soloActivos ? 'WHERE activo' : ''} ORDER BY categoria, nombre`
  );
  res.json(rows);
}

// GET /api/productos/:id
export async function obtener(req, res) {
  const { rows } = await query(`SELECT ${CAMPOS} FROM productos WHERE id = $1`, [idValido(req.params.id)]);
  if (!rows.length) throw new ErrorApi(404, 'Producto no encontrado');
  res.json(rows[0]);
}

// POST /api/productos   body = ProductoRequest(nombre, categoria, precio, activo)
export async function crear(req, res) {
  requerir(req.body, ['nombre', 'categoria', 'precio']);
  const { nombre, categoria, precio, activo = true, descripcion = null, imagen_url = null } = req.body;
  validar(categoria, precio);
  const { rows } = await query(
    `INSERT INTO productos (nombre, categoria, precio, activo, descripcion, imagen_url)
     VALUES (UPPER($1), UPPER($2), $3, $4, $5, $6) RETURNING ${CAMPOS}`,
    [nombre, categoria, precio, activo, descripcion, imagen_url]
  );
  res.status(201).json(rows[0]);
}

// PUT /api/productos/:id   (solo cambia lo que llega)
export async function actualizar(req, res) {
  const { nombre, categoria, precio, activo, descripcion, imagen_url } = req.body;
  validar(categoria, precio);
  const { rows } = await query(
    `UPDATE productos SET
        nombre      = COALESCE(UPPER($1), nombre),
        categoria   = COALESCE(UPPER($2), categoria),
        precio      = COALESCE($3, precio),
        activo      = COALESCE($4, activo),
        descripcion = COALESCE($5, descripcion),
        imagen_url  = COALESCE($6, imagen_url)
      WHERE id = $7 RETURNING ${CAMPOS}`,
    [nombre, categoria, precio, activo, descripcion, imagen_url, idValido(req.params.id)]
  );
  if (!rows.length) throw new ErrorApi(404, 'Producto no encontrado');
  res.json(rows[0]);
}

// GET /api/productos/:id/combos   (modelo de Colab, solo los aprobados por el admin)
export async function combos(req, res) {
  const { rows } = await query(
    `SELECT c.id, p.id AS producto_id, p.nombre, p.precio, p.imagen_url, c.descuento_pct,
            ROUND(p.precio * (1 - c.descuento_pct / 100), 2) AS precio_combo
       FROM ml.combo_sugerido c JOIN productos p ON p.id = c.producto_sugerido_id
      WHERE c.producto_id = $1 AND c.aprobado AND p.activo
        AND (c.vigente_hasta IS NULL OR c.vigente_hasta >= CURRENT_DATE)
      ORDER BY c.lift DESC`,
    [idValido(req.params.id)]
  );
  res.json(rows);
}

function validar(categoria, precio) {
  if (categoria !== undefined && !CATEGORIAS.includes(String(categoria).toUpperCase())) {
    throw new ErrorApi(400, `Categoría debe ser una de: ${CATEGORIAS.join(', ')}`);
  }
  if (precio !== undefined && !(Number(precio) > 0)) throw new ErrorApi(400, 'El precio debe ser mayor a 0');
}