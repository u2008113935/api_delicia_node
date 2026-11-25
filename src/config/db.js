// Conexion a Neon Postgres con un pool de conexiones.
// La cadena de conexion viene de .env (DATABASE_URL), nunca del codigo.
import pg from 'pg';

const { Pool, types } = pg;

// NUMERIC llega como texto: lo convertimos a numero (el app espera Double)
types.setTypeParser(1700, (valor) => parseFloat(valor));
// DATE llega como Date de JS y cambia de dia por la zona horaria: lo dejamos "2026-11-23"
types.setTypeParser(1082, (valor) => valor);

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en el archivo .env');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,                        // el plan gratuito de Neon admite pocas conexiones
  idleTimeoutMillis: 30000,
});

// Consulta simple: query('SELECT ... WHERE id = $1', [id])
export const query = (texto, params) => pool.query(texto, params);

// Transaccion: varias consultas que se guardan juntas o no se guarda ninguna
export async function transaccion(trabajo) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}