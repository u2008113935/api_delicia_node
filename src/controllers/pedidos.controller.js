// app: PedidoDto, CambioEstadoPedidoRequest
import { query, transaccion } from '../config/db.js';
import { ErrorApi, fechaValida, horaValida, idValido, requerir, uuidValido } from '../utils/errores.js';
import { SELECT_PEDIDO, cambiarEstado as cambiarEstadoPedido } from '../services/flujoPedido.js';

// POST /api/pedidos
// CLIENTE (web/app):  { items, fecha_entrega, hora_entrega, nota, canal: "WEB" | "APP" }
// ADMIN/EMPLEADO:     + cliente_nombre, cliente_telefono, canal: "MOSTRADOR" | "WHATSAPP"
// items: [{ producto_id, cantidad }]
export async function crear(req, res) {
  requerir(req.body, ['items', 'fecha_entrega', 'hora_entrega']);
  const { items, nota = null } = req.body;
  const fecha = fechaValida(req.body.fecha_entrega, 'fecha_entrega');
  const hora = horaValida(req.body.hora_entrega);
  if (!Array.isArray(items) || !items.length) throw new ErrorApi(400, 'El pedido no tiene productos');
  if (fecha < new Date().toISOString().slice(0, 10)) throw new ErrorApi(400, 'La fecha de entrega ya pasó');

  const u = req.usuario;
  let cliente;
  if (u.rol === 'CLIENTE') {
    const canal = req.body.canal ?? 'APP';
    if (!['WEB', 'APP'].includes(canal)) throw new ErrorApi(400, 'Canal debe ser WEB o APP');
    const { rows } = await query('SELECT nombre, telefono FROM usuarios WHERE id = $1', [u.id]);
    cliente = { id: u.id, nombre: rows[0].nombre, telefono: rows[0].telefono ?? '-', canal };
  } else {
    requerir(req.body, ['cliente_nombre', 'cliente_telefono']);
    const canal = req.body.canal ?? 'MOSTRADOR';
    if (!['MOSTRADOR', 'WHATSAPP'].includes(canal)) throw new ErrorApi(400, 'Canal debe ser MOSTRADOR o WHATSAPP');
    cliente = { id: null, nombre: req.body.cliente_nombre, telefono: req.body.cliente_telefono, canal };
  }

  const id = await transaccion(async (db) => {
    const { rows: [cab] } = await db.query(
      `INSERT INTO pedidos (cliente_id, cliente_nombre, cliente_telefono, canal, fecha_entrega, hora_entrega, nota, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [cliente.id, cliente.nombre, cliente.telefono, cliente.canal, fecha, hora, nota, u.id]
    );

    for (const item of items) {
      const cantidad = Number(item.cantidad);
      if (!Number.isInteger(cantidad) || cantidad <= 0) throw new ErrorApi(400, 'Cantidad inválida');
      // El precio SIEMPRE sale de la base, nunca del celular o la web
      const { rows } = await db.query('SELECT id, precio FROM productos WHERE id = $1 AND activo',
        [idValido(item.producto_id)]);
      if (!rows.length) throw new ErrorApi(404, `Producto ${item.producto_id} no disponible`);
      await db.query(
        'INSERT INTO pedido_detalle (pedido_id, producto_id, cantidad, precio_unit) VALUES ($1, $2, $3, $4)',
        [cab.id, rows[0].id, cantidad, rows[0].precio]
      );
    }

    await db.query(
      'UPDATE pedidos SET total = (SELECT SUM(subtotal) FROM pedido_detalle WHERE pedido_id = $1) WHERE id = $1',
      [cab.id]
    );
    await db.query(
      `INSERT INTO pedido_historial (pedido_id, estado_anterior, estado_nuevo, usuario_id, nota)
       VALUES ($1, NULL, 'PEND_PAGO', $2, $3)`,
      [cab.id, u.id, `Registrado por ${cliente.canal}`]
    );
    return cab.id;
  });

  res.status(201).json(await detalle(id));
}

// GET /api/pedidos?estado=PAGADO&canal=WHATSAPP&fecha=2026-11-23   (bandeja del admin)
export async function listar(req, res) {
  const filtros = [];
  const params = [];
  const agregar = (sql, valor) => { params.push(valor); filtros.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.estado) agregar('p.estado = ?', req.query.estado);
  if (req.query.canal) agregar('p.canal = ?', req.query.canal);
  if (req.query.fecha) agregar('p.fecha_entrega = ?', fechaValida(req.query.fecha));
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const { rows } = await query(
    `${SELECT_PEDIDO} ${where} ORDER BY p.fecha_entrega DESC, p.hora_entrega LIMIT 300`, params
  );
  res.json(rows);
}

// GET /api/pedidos/mis-pedidos   (cliente)
export async function misPedidos(req, res) {
  const { rows } = await query(`${SELECT_PEDIDO} WHERE p.cliente_id = $1 ORDER BY p.creado_en DESC`, [req.usuario.id]);
  res.json(rows);
}

// GET /api/pedidos/:id   (cabecera + productos + historial + ordenes + pago)
export async function obtener(req, res) {
  const pedido = await detalle(uuidValido(req.params.id));
  if (req.usuario.rol === 'CLIENTE' && pedido.cliente_id !== req.usuario.id) {
    throw new ErrorApi(404, 'Pedido no encontrado');     // no revela pedidos ajenos
  }
  res.json(pedido);
}

// PATCH /api/pedidos/:id/estado   body: { estado, nota }
export async function cambiarEstado(req, res) {
  requerir(req.body, ['estado']);
  const id = uuidValido(req.params.id);
  await transaccion((db) => cambiarEstadoPedido(db, id, req.body.estado, req.usuario, { nota: req.body.nota }));
  const { rows } = await query(`${SELECT_PEDIDO} WHERE p.id = $1`, [id]);
  res.json(rows[0]);                                     // PedidoDto actualizado
}

// ---------------------------------------------------------------------
export async function detalle(id) {
  const { rows } = await query(`${SELECT_PEDIDO} WHERE p.id = $1`, [id]);
  if (!rows.length) throw new ErrorApi(404, 'Pedido no encontrado');
  const pedido = rows[0];

  const [items, historial, ordenes, pagos] = await Promise.all([
    query(`SELECT d.producto_id, pr.nombre AS producto_nombre, d.cantidad, d.precio_unit, d.subtotal
             FROM pedido_detalle d JOIN productos pr ON pr.id = d.producto_id
            WHERE d.pedido_id = $1 ORDER BY d.id`, [id]),
    query(`SELECT h.estado_anterior, h.estado_nuevo, h.nota,
                  TO_CHAR(h.fecha AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS fecha,
                  u.nombre AS usuario, u.rol
             FROM pedido_historial h LEFT JOIN usuarios u ON u.id = h.usuario_id
            WHERE h.pedido_id = $1 ORDER BY h.fecha, h.id`, [id]),
    query(`SELECT o.id, pr.nombre AS producto_nombre, o.cantidad, o.estado
             FROM ordenes_produccion o JOIN productos pr ON pr.id = o.producto_id
            WHERE o.pedido_id = $1 ORDER BY o.id`, [id]),
    query(`SELECT id AS pago_id, referencia, monto, estado, nro_operacion_banco
             FROM pagos WHERE pedido_id = $1 ORDER BY creado_en DESC`, [id]),
  ]);
  return { ...pedido, items: items.rows, historial: historial.rows, ordenes: ordenes.rows, pagos: pagos.rows };
}