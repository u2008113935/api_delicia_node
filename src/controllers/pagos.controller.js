// Pagos con QR de Banco Andino.   app: QrRequest, QrResponse, PagoEstadoDto
// El celular NUNCA habla con el banco: solo la API, y solo la API confirma un pago.
//
// MODO SIMULADO (por defecto): la API arma el QR y el admin confirma con
// POST /api/pagos/:id/simular  (para la demo en clase).
// MODO REAL: Banco Andino llama a POST /api/pagos/webhook con la firma secreta.
import { query, transaccion } from '../config/db.js';
import { ErrorApi, requerir, uuidValido } from '../utils/errores.js';
import { cambiarEstado } from '../services/flujoPedido.js';

const RESPUESTA_PAGO = `id AS pago_id, referencia, qr_texto, monto, estado, nro_operacion_banco`;

// POST /api/pagos/qr   body: { pedido_id }
export async function generarQr(req, res) {
  requerir(req.body, ['pedido_id']);
  const pedidoId = uuidValido(req.body.pedido_id);

  const { rows } = await query('SELECT id, codigo, total, estado, cliente_id FROM pedidos WHERE id = $1', [pedidoId]);
  const p = rows[0];
  if (!p || (req.usuario.rol === 'CLIENTE' && p.cliente_id !== req.usuario.id)) {
    throw new ErrorApi(404, 'Pedido no encontrado');
  }
  if (p.estado !== 'PEND_PAGO') throw new ErrorApi(409, `El pedido está ${p.estado}, no se puede cobrar`);

  // Si ya hay un QR pendiente, se reutiliza (no se cobra dos veces)
  const previo = await query(`SELECT ${RESPUESTA_PAGO} FROM pagos WHERE pedido_id = $1 AND estado = 'PENDIENTE'`, [pedidoId]);
  if (previo.rows.length) return res.json(previo.rows[0]);

  // Texto del QR: en modo real lo devuelve Banco Andino
  const qrTexto = `BANCOANDINO|PAGO|DELICIA|${p.codigo}|${p.total.toFixed(2)}|PEN`;
  const { rows: [pago] } = await query(
    `INSERT INTO pagos (pedido_id, referencia, monto, qr_texto) VALUES ($1, $2, $3, $4) RETURNING ${RESPUESTA_PAGO}`,
    [pedidoId, p.codigo, p.total, qrTexto]
  );
  res.status(201).json(pago);
}

// GET /api/pagos/:id   (el app pregunta cada pocos segundos hasta que cambie)
export async function consultar(req, res) {
  const { rows } = await query(`SELECT ${RESPUESTA_PAGO} FROM pagos WHERE id = $1`, [uuidValido(req.params.id)]);
  if (!rows.length) throw new ErrorApi(404, 'Pago no encontrado');
  res.json(rows[0]);
}

// POST /api/pagos/:id/simular   body: { resultado: "CONFIRMADO" | "RECHAZADO" }   (solo ADMIN, demo)
export async function simular(req, res) {
  const resultado = req.body?.resultado ?? 'CONFIRMADO';
  const nro = resultado === 'CONFIRMADO' ? `BA-${Date.now().toString().slice(-8)}` : null;
  res.json(await registrarRespuestaBanco(uuidValido(req.params.id), resultado, nro, req.usuario));
}

// POST /api/pagos/webhook   (lo llama Banco Andino)
// header x-banco-firma = BANCO_WEBHOOK_SECRET ; body: { pago_id, estado, nro_operacion }
export async function webhook(req, res) {
  if (!process.env.BANCO_WEBHOOK_SECRET || req.headers['x-banco-firma'] !== process.env.BANCO_WEBHOOK_SECRET) {
    throw new ErrorApi(401, 'Firma del banco inválida');
  }
  requerir(req.body, ['pago_id', 'estado']);
  res.json(await registrarRespuestaBanco(uuidValido(req.body.pago_id), req.body.estado, req.body.nro_operacion, { id: null, rol: 'SISTEMA' }));
}

async function registrarRespuestaBanco(pagoId, resultado, nroOperacion, usuario) {
  if (!['CONFIRMADO', 'RECHAZADO'].includes(resultado)) throw new ErrorApi(400, 'Resultado inválido');
  return transaccion(async (db) => {
    const { rows } = await db.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [pagoId]);
    const pago = rows[0];
    if (!pago) throw new ErrorApi(404, 'Pago no encontrado');
    if (pago.estado !== 'PENDIENTE') throw new ErrorApi(409, `El pago ya está ${pago.estado}`);

    await db.query(
      `UPDATE pagos SET estado = $1, nro_operacion_banco = $2, confirmado_en = now() WHERE id = $3`,
      [resultado, nroOperacion, pagoId]
    );
    // Pago confirmado -> pedido PAGADO -> se crean las ordenes de produccion
    if (resultado === 'CONFIRMADO') {
      await cambiarEstado(db, pago.pedido_id, 'PAGADO', usuario,
        { sistema: true, nota: `Banco Andino op. ${nroOperacion}` });
    }
    const { rows: [r] } = await db.query(`SELECT ${RESPUESTA_PAGO} FROM pagos WHERE id = $1`, [pagoId]);
    return r;
  });
}