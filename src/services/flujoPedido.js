// Reglas del negocio del pedido en UN solo lugar.
// Las usan: pedidos (cambio manual), pagos (el banco confirma) y produccion (el empleado termina).
import { ErrorApi } from '../utils/errores.js';

// Cambios permitidos y que rol puede hacerlos   (enum EstadoPedido del app)
export const TRANSICIONES = {
  PEND_PAGO:      { PAGADO: ['ADMIN'], CANCELADO: ['ADMIN', 'CLIENTE'] },
  PAGADO:         { EN_PREPARACION: ['EMPLEADO', 'ADMIN'], CANCELADO: ['ADMIN'] },
  EN_PREPARACION: { LISTO: ['EMPLEADO', 'ADMIN'] },
  LISTO:          { ENTREGADO: ['EMPLEADO', 'ADMIN'] },
  ENTREGADO:      {},
  CANCELADO:      {},
};

// Columnas que espera PedidoDto (fecha y hora como texto: "2026-11-23", "15:30")
export const SELECT_PEDIDO = `
  SELECT p.id, p.codigo, p.cliente_nombre, p.cliente_telefono, p.canal, p.total,
         p.fecha_entrega, TO_CHAR(p.hora_entrega, 'HH24:MI') AS hora_entrega,
         p.estado, p.nota, p.cliente_id, p.creado_en, p.actualizado_en
    FROM pedidos p`;

/**
 * Cambia el estado de un pedido dentro de una transaccion (db).
 * usuario = { id, rol } ; sistema = true cuando lo hace la API sola (banco, produccion)
 */
export async function cambiarEstado(db, pedidoId, nuevo, usuario, { nota = null, sistema = false } = {}) {
  const { rows } = await db.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
  const p = rows[0];
  if (!p || (usuario.rol === 'CLIENTE' && p.cliente_id !== usuario.id)) {
    throw new ErrorApi(404, 'Pedido no encontrado');
  }
  if (p.estado === nuevo) return p;                       // nada que hacer

  const permitidos = TRANSICIONES[p.estado]?.[nuevo];
  if (!permitidos) throw new ErrorApi(409, `No se puede pasar de ${p.estado} a ${nuevo}`);
  if (!sistema && !permitidos.includes(usuario.rol)) {
    throw new ErrorApi(403, `El rol ${usuario.rol} no puede marcar ${nuevo}`);
  }

  await db.query('UPDATE pedidos SET estado = $1, actualizado_en = now() WHERE id = $2', [nuevo, pedidoId]);
  await db.query(
    `INSERT INTO pedido_historial (pedido_id, estado_anterior, estado_nuevo, usuario_id, nota)
     VALUES ($1, $2, $3, $4, $5)`,
    [pedidoId, p.estado, nuevo, usuario.id ?? null, nota]
  );

  // Pagado = se manda a producir: una orden por cada producto del pedido
  if (nuevo === 'PAGADO') {
    await db.query(
      `INSERT INTO ordenes_produccion (pedido_id, producto_id, cantidad, fecha_produccion, hora_entrega)
       SELECT d.pedido_id, d.producto_id, d.cantidad, p.fecha_entrega, p.hora_entrega
         FROM pedido_detalle d JOIN pedidos p ON p.id = d.pedido_id
        WHERE d.pedido_id = $1`,
      [pedidoId]
    );
  }

  // Cancelado = se borran las ordenes que aun no empezaron
  if (nuevo === 'CANCELADO') {
    await db.query(`DELETE FROM ordenes_produccion WHERE pedido_id = $1 AND estado = 'PLANIFICADA'`, [pedidoId]);
  }
  return { ...p, estado: nuevo };
}

/**
 * Cuando el empleado avanza una orden, el pedido se actualiza solo:
 * primera orden EN_PROCESO  -> pedido EN_PREPARACION
 * todas las ordenes TERMINADA -> pedido LISTO
 */
export async function sincronizarConOrdenes(db, pedidoId, usuario) {
  if (!pedidoId) return;
  const { rows: [r] } = await db.query(
    `SELECT p.estado,
            COUNT(o.id)                                       AS total,
            COUNT(o.id) FILTER (WHERE o.estado = 'TERMINADA') AS terminadas,
            COUNT(o.id) FILTER (WHERE o.estado <> 'PLANIFICADA') AS iniciadas
       FROM pedidos p LEFT JOIN ordenes_produccion o ON o.pedido_id = p.id
      WHERE p.id = $1 GROUP BY p.estado`,
    [pedidoId]
  );
  if (!r) return;
  const sistema = { sistema: true, nota: 'Automático por producción' };

  if (r.estado === 'PAGADO' && Number(r.iniciadas) > 0) {
    await cambiarEstado(db, pedidoId, 'EN_PREPARACION', usuario, sistema);
    r.estado = 'EN_PREPARACION';
  }
  if (r.estado === 'EN_PREPARACION' && Number(r.total) > 0 && Number(r.total) === Number(r.terminadas)) {
    await cambiarEstado(db, pedidoId, 'LISTO', usuario, sistema);
  }
}