// Ordenes de produccion.  app: OrdenDto, CambioEstadoOrdenRequest, PlanRequest
import { query, transaccion } from '../config/db.js';
import { ErrorApi, fechaValida, idValido, requerir, uuidValido } from '../utils/errores.js';
import { sincronizarConOrdenes } from '../services/flujoPedido.js';

const SELECT_ORDEN = `
  SELECT o.id, o.pedido_id, p.codigo AS pedido_codigo, o.producto_id, pr.nombre AS producto_nombre,
         o.cantidad, o.fecha_produccion, TO_CHAR(o.hora_entrega, 'HH24:MI') AS hora_entrega,
         o.estado, u.nombre AS empleado
    FROM ordenes_produccion o
    JOIN productos pr     ON pr.id = o.producto_id
    LEFT JOIN pedidos p   ON p.id = o.pedido_id
    LEFT JOIN usuarios u  ON u.id = o.empleado_id`;

// Orden normal: PLANIFICADA -> EN_PROCESO -> TERMINADA
// (se acepta PLANIFICADA -> TERMINADA por si el empleado marco todo sin señal)
const SIGUIENTES = { PLANIFICADA: ['EN_PROCESO', 'TERMINADA'], EN_PROCESO: ['TERMINADA'], TERMINADA: [] };

// GET /api/produccion/ordenes?fecha=2026-11-23   (cola del empleado)
export async function listar(req, res) {
  requerir(req.query, ['fecha']);
  const { rows } = await query(
    `${SELECT_ORDEN} WHERE o.fecha_produccion = $1 ORDER BY o.hora_entrega, pr.nombre`,
    [fechaValida(req.query.fecha)]
  );
  res.json(rows);
}

// PATCH /api/produccion/ordenes/:id/estado   body: { uuid, estado }   (lo envia el SyncWorker)
export async function cambiarEstado(req, res) {
  requerir(req.body, ['uuid', 'estado']);
  const id = uuidValido(req.params.id);
  const opUuid = uuidValido(req.body.uuid);
  const nuevo = req.body.estado;

  await transaccion(async (db) => {
    // 1) ¿Ya recibimos esta operacion? (el worker puede reenviar) -> responder igual, sin repetir
    const { rowCount } = await db.query(
      `INSERT INTO operaciones_sync (uuid, tipo, usuario_id) VALUES ($1, 'CAMBIO_ESTADO_ORDEN', $2)
       ON CONFLICT (uuid) DO NOTHING`,
      [opUuid, req.usuario.id]
    );
    if (rowCount === 0) return;

    const { rows } = await db.query('SELECT * FROM ordenes_produccion WHERE id = $1 FOR UPDATE', [id]);
    const orden = rows[0];
    if (!orden) throw new ErrorApi(404, 'Orden no encontrada');
    if (orden.estado === nuevo) return;
    if (!SIGUIENTES[orden.estado]?.includes(nuevo)) {
      throw new ErrorApi(409, `No se puede pasar la orden de ${orden.estado} a ${nuevo}`);
    }

    await db.query(
      `UPDATE ordenes_produccion SET estado = $1, empleado_id = COALESCE(empleado_id, $2), actualizado_en = now()
        WHERE id = $3`,
      [nuevo, req.usuario.id, id]
    );
    // El pedido avanza solo (EN_PREPARACION / LISTO)
    await sincronizarConOrdenes(db, orden.pedido_id, req.usuario);
  });

  const { rows } = await query(`${SELECT_ORDEN} WHERE o.id = $1`, [id]);
  res.json(rows[0]);
}

// POST /api/produccion/plan   body: { fecha, items: [{ producto_id, cantidad }] }   (ADMIN)
// El admin aprueba (y puede ajustar) lo que sugirio el ML: se crean ordenes sin pedido
export async function aprobarPlan(req, res) {
  requerir(req.body, ['fecha', 'items']);
  const fecha = fechaValida(req.body.fecha);
  const items = (req.body.items || []).filter((i) => Number(i.cantidad) > 0);
  if (!items.length) throw new ErrorApi(400, 'El plan no tiene cantidades');

  const ids = await transaccion(async (db) => {
    // Si se aprueba de nuevo el mismo dia, se reemplazan las del plan que aun no empezaron
    await db.query(
      `DELETE FROM ordenes_produccion WHERE fecha_produccion = $1 AND pedido_id IS NULL AND estado = 'PLANIFICADA'`,
      [fecha]
    );
    const creadas = [];
    for (const it of items) {
      const { rows: [o] } = await db.query(
        `INSERT INTO ordenes_produccion (producto_id, cantidad, fecha_produccion, hora_entrega)
         VALUES ($1, $2, $3, '07:00') RETURNING id`,
        [idValido(it.producto_id), Number(it.cantidad), fecha]
      );
      creadas.push(o.id);
    }
    return creadas;
  });

  const { rows } = await query(`${SELECT_ORDEN} WHERE o.id = ANY($1::uuid[]) ORDER BY pr.nombre`, [ids]);
  res.status(201).json(rows);
}