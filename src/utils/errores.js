// Error con codigo HTTP: lanzarlo desde cualquier controlador
// throw new ErrorApi(404, 'Pedido no encontrado')
export class ErrorApi extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

// Validacion minima de campos obligatorios
export function requerir(body, campos) {
  const faltan = campos.filter((c) => body?.[c] === undefined || body[c] === null || body[c] === '');
  if (faltan.length) throw new ErrorApi(400, `Faltan campos: ${faltan.join(', ')}`);
}

export function idValido(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) throw new ErrorApi(400, 'Id inválido');
  return id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidValido(valor) {
  if (!UUID.test(String(valor))) throw new ErrorApi(400, 'Id inválido');
  return valor;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
export function fechaValida(valor, campo = 'fecha') {
  if (!FECHA.test(String(valor))) throw new ErrorApi(400, `${campo} debe tener formato AAAA-MM-DD`);
  return valor;
}

const HORA = /^\d{2}:\d{2}$/;
export function horaValida(valor) {
  if (!HORA.test(String(valor))) throw new ErrorApi(400, 'hora_entrega debe tener formato HH:MM');
  return valor;
}