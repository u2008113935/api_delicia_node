// Todas las rutas en un solo archivo: se ve de un vistazo quien puede hacer que.
// Cada ruta corresponde a una funcion del ApiService del app Android.
import { Router } from 'express';
import { verificarToken, tokenOpcional, permitirRoles } from '../middlewares/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as productos from '../controllers/productos.controller.js';
import * as pedidos from '../controllers/pedidos.controller.js';
import * as pagos from '../controllers/pagos.controller.js';
import * as produccion from '../controllers/produccion.controller.js';
import * as analitica from '../controllers/analitica.controller.js';
import * as admin from '../controllers/admin.controller.js';

const r = Router();
const ADMIN = permitirRoles('ADMIN');
const PERSONAL = permitirRoles('ADMIN', 'EMPLEADO');
const CLIENTE = permitirRoles('CLIENTE');

// ── Publico ──────────────────────────────────────────────────────────
r.post('/auth/login', auth.login);                       // login()
r.post('/auth/registro', auth.registrar);                // web / App Cliente
r.get('/productos', tokenOpcional, productos.listar);    // obtenerProductos()
r.get('/productos/:id', productos.obtener);
r.get('/productos/:id/combos', productos.combos);
r.post('/pagos/webhook', pagos.webhook);                 // lo llama Banco Andino

// ── Desde aqui todo pide token ───────────────────────────────────────
r.use(verificarToken);
r.get('/auth/perfil', auth.perfil);

// Productos (ADMIN)
r.post('/productos', ADMIN, productos.crear);             // crearProducto()
r.put('/productos/:id', ADMIN, productos.actualizar);     // actualizarProducto()

// Pedidos
r.post('/pedidos', pedidos.crear);                        // cliente, mostrador o WhatsApp
r.get('/pedidos/mis-pedidos', CLIENTE, pedidos.misPedidos);
r.get('/pedidos', PERSONAL, pedidos.listar);              // obtenerPedidos()
r.get('/pedidos/:id', pedidos.obtener);                   // obtenerPedido()
r.patch('/pedidos/:id/estado', pedidos.cambiarEstado);    // cambiarEstadoPedido()

// Pagos Banco Andino
r.post('/pagos/qr', permitirRoles('ADMIN', 'CLIENTE'), pagos.generarQr);   // generarQr()
r.get('/pagos/:id', pagos.consultar);                                       // consultarPago()
r.post('/pagos/:id/simular', ADMIN, pagos.simular);                         // demo en clase

// Produccion
r.get('/produccion/ordenes', PERSONAL, produccion.listar);                  // obtenerOrdenes()
r.patch('/produccion/ordenes/:id/estado', PERSONAL, produccion.cambiarEstado); // cambiarEstadoOrden()
r.post('/produccion/plan', ADMIN, produccion.aprobarPlan);                  // aprobarPlan()

// Merma, ML y tablero
r.post('/merma', PERSONAL, analitica.registrarMerma);                       // registrarMerma()
r.get('/ml/produccion-sugerida', ADMIN, analitica.produccionSugerida);      // obtenerProduccionSugerida()
r.get('/kpis', ADMIN, analitica.tablero);                                   // obtenerTablero()

// Personal y combos (ADMIN)
r.get('/admin/usuarios', ADMIN, admin.listarUsuarios);
r.post('/admin/usuarios', ADMIN, admin.crearUsuario);
r.put('/admin/usuarios/:id', ADMIN, admin.editarUsuario);
r.get('/admin/combos', ADMIN, admin.listarCombos);
r.patch('/admin/combos/:id', ADMIN, admin.decidirCombo);

export default r;