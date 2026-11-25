// Merma (empleado), ML y tablero (admin).
// app: MermaRequest, ProduccionSugeridaDto, TableroDto
import { query } from '../config/db.js';
import { ErrorApi, fechaValida, idValido, requerir, uuidValido } from '../utils/errores.js';

// POST /api/merma   body: { uuid, fecha, producto_id, cantidad, motivo }
// El uuid es la clave: si el SyncWorker la reenvia, no se duplica
export async function registrarMerma(req, res) {
  requerir(req.body, ['uuid', 'fecha', 'producto_id', 'cantidad', 'motivo']);
  const { motivo } = req.body;
  if (!['NO_VENDIDO', 'DAÑADO', 'VENCIDO'].includes(motivo)) {
    throw new ErrorApi(400, 'Motivo debe ser NO_VENDIDO, DAÑADO o VENCIDO');
  }
  const cantidad = Number(req.body.cantidad);
  if (!Number.isInteger(cantidad) || cantidad <= 0) throw new ErrorApi(400, 'Cantidad inválida');

  await query(
    `INSERT INTO merma (uuid, fecha, producto_id, cantidad, motivo, empleado_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (uuid) DO NOTHING`,
    [uuidValido(req.body.uuid), fechaValida(req.body.fecha), idValido(req.body.producto_id), cantidad, motivo, req.usuario.id]
  );
  res.status(201).json({ registrado: true });
}

// GET /api/ml/produccion-sugerida?fecha=2026-11-24   (lo escribio el notebook de Colab)
export async function produccionSugerida(req, res) {
  requerir(req.query, ['fecha']);
  const { rows } = await query(
    `SELECT s.fecha, s.producto_id, p.nombre AS producto_nombre, s.cantidad_sugerida,
            s.cantidad_min, s.cantidad_max, s.modelo_version
       FROM ml.produccion_sugerida s JOIN productos p ON p.id = s.producto_id
      WHERE s.fecha = $1 AND p.activo ORDER BY p.nombre`,
    [fechaValida(req.query.fecha)]
  );
  res.json(rows);
}

// GET /api/kpis?desde=2026-11-17&hasta=2026-11-23   (lee las vistas del esquema dw)
// Devuelve TableroDto: { desde, hasta, kpis[], ventasPorDia[], mermaPorProducto[] }
export async function tablero(req, res) {
  requerir(req.query, ['desde', 'hasta']);
  const desde = fechaValida(req.query.desde, 'desde');
  const hasta = fechaValida(req.query.hasta, 'hasta');
  if (desde > hasta) throw new ErrorApi(400, 'desde no puede ser mayor que hasta');

  // Periodo anterior del mismo largo, para la variacion
  const { rows: [ant] } = await query(
    `SELECT ($1::date - ($2::date - $1::date + 1))::text AS desde, ($1::date - 1)::text AS hasta`, [desde, hasta]);

  const [actual, previo] = await Promise.all([indicadores(desde, hasta), indicadores(ant.desde, ant.hasta)]);
  const variacion = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

  const kpis = [
    { nombre: 'Ventas',          valor: actual.ventas,   unidad: 'S/',      variacion: variacion(actual.ventas, previo.ventas) },
    { nombre: 'Pedidos',         valor: actual.pedidos,  unidad: 'pedidos', variacion: variacion(actual.pedidos, previo.pedidos) },
    { nombre: 'Ticket promedio', valor: actual.ticket,   unidad: 'S/',      variacion: variacion(actual.ticket, previo.ticket) },
    { nombre: '% Merma',         valor: actual.merma,    unidad: '%',       variacion: variacion(actual.merma, previo.merma) },
    { nombre: 'MAPE',            valor: actual.mape,     unidad: '%',       variacion: null },
  ];

  const [porDia, merma] = await Promise.all([
    query(`SELECT (ARRAY['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'])[EXTRACT(ISODOW FROM f)::int]
                  || ' ' || TO_CHAR(f, 'DD') AS etiqueta,
                  COALESCE(v.ventas, 0)::float AS valor
             FROM generate_series($1::date, $2::date, '1 day') f
             LEFT JOIN dw.v_ventas_diarias v ON v.fecha = f::date
            ORDER BY f`, [desde, hasta]),
    query(`SELECT producto AS etiqueta, SUM(unidades)::float AS valor
             FROM dw.v_merma_producto WHERE fecha BETWEEN $1 AND $2
            GROUP BY producto ORDER BY valor DESC`, [desde, hasta]),
  ]);

  res.json({ desde, hasta, kpis, ventasPorDia: porDia.rows, mermaPorProducto: merma.rows });
}

async function indicadores(desde, hasta) {
  const { rows: [r] } = await query(
    `SELECT
       (SELECT COALESCE(SUM(ventas), 0)  FROM dw.v_ventas_diarias WHERE fecha BETWEEN $1 AND $2) AS ventas,
       (SELECT COALESCE(SUM(pedidos), 0) FROM dw.v_ventas_diarias WHERE fecha BETWEEN $1 AND $2) AS pedidos,
       (SELECT COALESCE(SUM(unidades), 0) FROM dw.v_ventas_diarias WHERE fecha BETWEEN $1 AND $2) AS vendidas,
       (SELECT COALESCE(SUM(unidades), 0) FROM dw.v_merma_producto WHERE fecha BETWEEN $1 AND $2) AS mermadas,
       (SELECT AVG(ABS(cantidad_real - cantidad_sugerida)::float / cantidad_real) * 100
          FROM dw.v_pronostico_vs_real WHERE fecha BETWEEN $1 AND $2 AND cantidad_real > 0) AS mape`,
    [desde, hasta]
  );
  const ventas = Number(r.ventas);
  const pedidos = Number(r.pedidos);
  const producidas = Number(r.vendidas) + Number(r.mermadas);
  const redondear = (x) => Math.round(x * 10) / 10;
  return {
    ventas,
    pedidos,
    ticket: pedidos ? Math.round((ventas / pedidos) * 100) / 100 : 0,
    merma: producidas ? redondear((Number(r.mermadas) / producidas) * 100) : 0,
    mape: r.mape === null ? 0 : redondear(r.mape),
  };
}