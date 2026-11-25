# API Delicia

API REST de **Pastelería Delicia**. Es el único punto de entrada a la base de datos `bd_delicia_crm` (Neon Postgres) para todas las aplicaciones del ecosistema:

| Quién la usa | Para qué |
|---|---|
| App Android Administrador / Empleado (`app19_jc_adm_emp_etl_ml_bi`) | Bandeja de pedidos, cobro con QR, productos, plan de producción, tablero, cola de preparación y merma |
| Web React (deliciapasteleria.online) | Catálogo, registro de clientes, pedidos y pago |
| App Cliente | Catálogo, combos sugeridos y seguimiento del pedido |
| Banco Andino (simulado) | Confirma los pagos por QR |

Ninguna app se conecta directo a la base de datos. Todas hablan con la API, y la API decide qué se permite.

---

## 1. La idea en una imagen

```
  App Android        Web React        App Cliente        Banco Andino
  (ADMIN/EMPLEADO)   (CLIENTE)        (CLIENTE)          (webhook)
        \                |                 |                 /
         \               |   HTTP + JSON   |                /
          \              |   token JWT     |               /
           +-------------+-----------------+--------------+
                                  |
                          +---------------+
                          |   API Delicia |   Node.js + Express
                          |   (este repo) |
                          +---------------+
                                  |  SQL (pg)
                          +---------------+
                          |     Neon      |   Postgres en la nube
                          | bd_delicia_crm|
                          +---------------+
                           public | ml | dw
                                  |
                     Colab (modelo ML)  Power BI (tablero)
```

- **public**: tablas operacionales (usuarios, productos, pedidos, pagos, producción, merma).
- **ml**: resultados del modelo que se entrena en Colab (producción sugerida, combos).
- **dw**: vistas para el tablero del app y para Power BI. No hacen falta archivos CSV.

---

## 2. Qué pasa cuando llega una petición

Ejemplo: el administrador abre la bandeja de pedidos en el celular.

```
GET /api/pedidos
Authorization: Bearer eyJhbGciOi...
```

```
1. server.js        Arranca Express en el puerto 8000
2. app.js           CORS, lectura de JSON, monta las rutas en /api
3. routes/index.js  Busca la ruta: r.get('/pedidos', PERSONAL, pedidos.listar)
4. middlewares/     verificarToken  -> ¿el token es válido? ¿el usuario sigue activo?
   auth.js          permitirRoles   -> ¿es ADMIN o EMPLEADO?
5. controllers/     pedidos.listar  -> arma el SQL con los filtros
   pedidos...js
6. config/db.js     Envía la consulta a Neon y devuelve las filas
7. Respuesta        200 OK + lista de pedidos en JSON
```

Si algo falla en cualquier paso, el **manejador de errores** de `app.js` responde con un JSON claro:

```json
{ "error": "No tienes permiso para esta acción" }
```

El app Android muestra ese mensaje tal cual en la pantalla.

---

## 3. Estructura de carpetas

Cada carpeta tiene una sola responsabilidad.

```
api_delicia_node/
├── sql/                         Scripts para crear la base en Neon (ejecutar en orden)
│   ├── 00_limpiar_version_anterior.sql
│   ├── 01_esquema_operacional.sql   Tablas de public
│   ├── 02_esquemas_ml_dw.sql        Esquemas ml y dw (vistas)
│   └── 03_datos_iniciales.sql       Usuarios y pedidos de prueba
├── src/
│   ├── server.js                Punto de arranque: lee el puerto y escucha
│   ├── app.js                   Configura Express, CORS, rutas y errores
│   ├── config/
│   │   └── db.js                Conexión a Neon (pool) y transacciones
│   ├── routes/
│   │   └── index.js             Mapa de TODAS las rutas y quién puede usarlas
│   ├── middlewares/
│   │   └── auth.js              Tokens JWT y control de roles
│   ├── controllers/             Una función por ruta: valida, consulta, responde
│   │   ├── auth.controller.js
│   │   ├── productos.controller.js
│   │   ├── pedidos.controller.js
│   │   ├── pagos.controller.js
│   │   ├── produccion.controller.js
│   │   ├── analitica.controller.js
│   │   └── admin.controller.js
│   ├── services/
│   │   └── flujoPedido.js       Reglas del negocio del pedido (estados)
│   └── utils/
│       └── errores.js           ErrorApi y validaciones comunes
├── .env.example                 Plantilla de variables (sin claves reales)
├── .gitignore                   Evita subir .env y node_modules
└── package.json                 Dependencias y comandos
```

**Regla para recordar:** la ruta dice *quién* puede entrar, el controlador dice *qué* se hace y el servicio guarda las *reglas del negocio* que se repiten.

---

## 4. Roles: quién hace qué

| Rol | Dónde entra | Qué puede hacer |
|---|---|---|
| **ADMIN** | App Android | Mantenimientos: productos, personal, combos. Cobra con QR, cancela y entrega pedidos, aprueba el plan del ML y ve el tablero |
| **EMPLEADO** | App Android | Atiende la producción: avanza órdenes en la cola, registra merma. Funciona sin señal |
| **CLIENTE** | Web / App Cliente | Ve el catálogo, se registra, hace pedidos, paga con QR y ve solo **sus** pedidos |

El rol viaja dentro del token. En `routes/index.js` se ve de un vistazo:

```js
const ADMIN    = permitirRoles('ADMIN');
const PERSONAL = permitirRoles('ADMIN', 'EMPLEADO');

r.post('/productos', ADMIN, productos.crear);          // solo el admin
r.get('/produccion/ordenes', PERSONAL, produccion.listar); // admin y empleado
```

---

## 5. El ciclo de vida de un pedido

Es el corazón del negocio. Las reglas viven en `services/flujoPedido.js` y **solo** la API puede cambiar un estado.

```
                 cobro QR o efectivo (ADMIN)
   PEND_PAGO  ------------------------------->  PAGADO
       |                                          |  se crean las órdenes
       | cancelar (ADMIN o el CLIENTE dueño)      |  de producción solas
       v                                          v
   CANCELADO  <---- cancelar (ADMIN) ----    EN_PREPARACION   <- el empleado inicia
                                                  |              la primera orden
                                                  v
                                                LISTO          <- el empleado termina
                                                  |              todas las órdenes
                                                  v
                                              ENTREGADO        <- ADMIN o EMPLEADO
```

Tres cosas que la API hace sola:

1. **Pago confirmado → PAGADO**: crea una orden de producción por cada producto del pedido.
2. **Primera orden EN_PROCESO → pedido EN_PREPARACION**.
3. **Todas las órdenes TERMINADA → pedido LISTO**.

Cada cambio deja una fila en `pedido_historial`: quién, cuándo, de qué estado a cuál. Así se tiene trazabilidad completa.

Si alguien intenta un salto no permitido (por ejemplo de `PEND_PAGO` a `ENTREGADO`), la API responde `409` con el motivo.

---

## 6. Pago con QR de Banco Andino (simulado)

El celular **nunca** habla con el banco. Solo la API lo hace, y solo la API confirma un pago.

```
App admin                    API                         Banco Andino
   |  POST /pagos/qr           |                               |
   |-------------------------->|  crea el pago PENDIENTE       |
   |<--------------------------|  devuelve el texto del QR     |
   |  muestra el QR            |                               |
   |                           |   el cliente paga con su app  |
   |                           |<------------------------------|
   |                           |  POST /pagos/webhook          |
   |                           |  (header x-banco-firma)       |
   |                           |  pago CONFIRMADO              |
   |                           |  pedido -> PAGADO             |
   |  GET /pagos/:id cada 3 s  |                               |
   |-------------------------->|                               |
   |<--------------------------|  estado: CONFIRMADO           |
```

Para la clase, el botón **"Simular pago del banco (demo)"** llama a `POST /api/pagos/:id/simular`, que hace el papel del banco.

Protecciones:
- Si ya hay un QR pendiente para el pedido, se reutiliza: no se cobra dos veces.
- El webhook exige la clave `BANCO_WEBHOOK_SECRET` en el header `x-banco-firma`.
- Un pago ya confirmado no se puede volver a confirmar.

---

## 7. Trabajo sin señal del empleado

En la cocina no siempre hay buena señal. El app guarda los cambios en el celular (Room) y un proceso en segundo plano (`SyncWorker`) los envía cuando vuelve la conexión.

El riesgo es que el mismo cambio llegue dos veces. Para evitarlo, cada operación lleva un **uuid** único:

```json
PATCH /api/produccion/ordenes/7c1e.../estado
{ "uuid": "b4f2...", "estado": "TERMINADA" }
```

La API guarda ese uuid en `operaciones_sync`. Si vuelve a llegar, responde igual pero **no repite** el cambio. Esto se llama **idempotencia**. La merma funciona igual: su clave primaria es el uuid.

---

## 8. Machine Learning y tablero sin CSV

```
Neon (dw.v_ventas_detalle)  -->  Colab entrena  -->  Neon (ml.produccion_sugerida)
                                                            |
App admin: Plan ML  <--  GET /api/ml/produccion-sugerida  <-+
   el admin ajusta y aprueba
   POST /api/produccion/plan  -->  órdenes para la cola del empleado
```

- **El modelo propone, el admin decide**: puede cambiar cada cantidad antes de aprobar.
- **Tablero** (`GET /api/kpis`): ventas, pedidos, ticket promedio, % de merma y **MAPE** (error promedio del pronóstico frente a lo vendido), con su variación frente al periodo anterior.
- **Power BI** se conecta directo a las vistas `dw.*` de Neon.

---

## 9. Endpoints

Todas las rutas empiezan con `/api`. Las marcadas con candado necesitan `Authorization: Bearer <token>`.

### Públicas

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/salud` | Comprueba que la API y Neon responden |
| POST | `/auth/login` | Inicia sesión. Acepta `correo` o `email` y `password` |
| POST | `/auth/registro` | Crea una cuenta de CLIENTE |
| GET | `/productos` | Catálogo (el admin también ve los inactivos) |
| GET | `/productos/:id` | Un producto |
| GET | `/productos/:id/combos` | Combos aprobados para ese producto |
| POST | `/pagos/webhook` | Confirmación del banco (con firma) |

### Con token

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/auth/perfil` | Todos | Datos del usuario |
| POST | `/productos` | ADMIN | Crear producto |
| PUT | `/productos/:id` | ADMIN | Editar o desactivar producto |
| POST | `/pedidos` | Todos | Crear pedido (el personal registra WhatsApp o mostrador) |
| GET | `/pedidos` | ADMIN, EMPLEADO | Bandeja con filtros `?estado=&canal=&fecha=` |
| GET | `/pedidos/mis-pedidos` | CLIENTE | Solo los suyos |
| GET | `/pedidos/:id` | Todos | Detalle: productos, historial, órdenes y pagos |
| PATCH | `/pedidos/:id/estado` | Según la regla | Cambiar estado |
| POST | `/pagos/qr` | ADMIN, CLIENTE | Generar QR de cobro |
| GET | `/pagos/:id` | Todos | Consultar estado del pago |
| POST | `/pagos/:id/simular` | ADMIN | Demo: el banco confirma |
| GET | `/produccion/ordenes?fecha=` | ADMIN, EMPLEADO | Cola del día |
| PATCH | `/produccion/ordenes/:id/estado` | ADMIN, EMPLEADO | Avanzar orden (con uuid) |
| POST | `/produccion/plan` | ADMIN | Aprobar plan del ML |
| POST | `/merma` | ADMIN, EMPLEADO | Registrar merma (con uuid) |
| GET | `/ml/produccion-sugerida?fecha=` | ADMIN | Pronóstico del modelo |
| GET | `/kpis?desde=&hasta=` | ADMIN | Tablero |
| GET | `/admin/usuarios` | ADMIN | Listar personal y clientes |
| POST | `/admin/usuarios` | ADMIN | Crear empleado o admin |
| PUT | `/admin/usuarios/:id` | ADMIN | Editar, desactivar o cambiar clave |
| GET | `/admin/combos` | ADMIN | Combos propuestos por el modelo |
| PATCH | `/admin/combos/:id` | ADMIN | Aprobar combo y fijar descuento |

### Códigos de respuesta

| Código | Significa |
|---|---|
| 200 / 201 | Correcto / creado |
| 400 | Faltan datos o tienen mal formato |
| 401 | Sin token, token vencido o usuario desactivado |
| 403 | El rol no tiene permiso |
| 404 | No existe (o no es tuyo) |
| 409 | Conflicto de negocio, por ejemplo un cambio de estado no permitido |
| 500 | Error interno: revisar la terminal de la API |

---

## 10. Seguridad aplicada

| Medida | Dónde |
|---|---|
| Claves con **bcrypt**, nunca en texto | `auth.controller.js`, `admin.controller.js` |
| **JWT** con vencimiento (`JWT_EXPIRA`) | `middlewares/auth.js` |
| Usuario desactivado pierde acceso al instante | `leerToken` consulta `activo` en cada petición |
| Mismo mensaje si el correo no existe o la clave falla | `login`: no revela qué correos están registrados |
| Consultas con parámetros `$1, $2` | Todos los controladores: evita inyección SQL |
| El precio sale de la base, no del celular | `pedidos.crear` |
| Un cliente no ve pedidos ajenos | Responde 404, no 403, para no revelar que existen |
| Transacciones con `FOR UPDATE` | Pagos y cambios de estado: dos personas no pisan el mismo pedido |
| CORS con lista blanca | `CORS_ORIGINS` en `.env` |
| Secretos fuera del código | `.env` está en `.gitignore` |

---

## 11. Instalación paso a paso

### Requisitos
- Node.js 20 o superior (`node -v`)
- Cuenta en Neon con el proyecto `bd_delicia_crm`

### 1. Base de datos
En Neon, abre `bd_delicia_crm`, rama **production**, **SQL Editor**, y ejecuta en orden:

```
sql/00_limpiar_version_anterior.sql
sql/01_esquema_operacional.sql
sql/02_esquemas_ml_dw.sql
sql/03_datos_iniciales.sql
```

Los scripts se pueden ejecutar dos veces sin romper nada y conservan los productos y sus fotos.

### 2. Variables de entorno
```powershell
copy .env.example .env
```

| Variable | De dónde sale |
|---|---|
| `DATABASE_URL` | Neon: botón **Connect**, rama production, copiar la cadena `postgresql://...` |
| `JWT_SECRET` | La inventas tú: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_EXPIRA` | Duración de la sesión, por ejemplo `8h` |
| `PORT` | `8000` (el app Android ya lo usa) |
| `BANCO_WEBHOOK_SECRET` | La inventas tú, con el mismo comando, distinta a la anterior |
| `CORS_ORIGINS` | Webs que pueden llamar a la API, separadas por coma |

> El archivo `.env` **nunca** se sube a GitHub.

### 3. Instalar y arrancar
```powershell
npm install
npm run dev
```

Debe aparecer:
```
API Delicia escuchando en http://localhost:8000/api
```

`npm run dev` reinicia la API cada vez que guardas un archivo.

---

## 12. Probar la API

### Desde el navegador
```
http://localhost:8000/api/salud
http://localhost:8000/api/productos
```

### Desde PowerShell
```powershell
# 1) Iniciar sesión y guardar el token
$login = Invoke-RestMethod -Method Post -Uri http://localhost:8000/api/auth/login `
  -ContentType "application/json" `
  -Body '{"correo":"admin@delicia.pe","password":"Admin2026*"}'
$h = @{ Authorization = "Bearer $($login.token)" }

# 2) Usar el token
Invoke-RestMethod http://localhost:8000/api/pedidos -Headers $h
Invoke-RestMethod "http://localhost:8000/api/kpis?desde=2026-11-19&hasta=2026-11-25" -Headers $h
```

### Desde el celular por USB
```powershell
adb reverse tcp:8000 tcp:8000
```
Así `127.0.0.1:8000` del celular apunta a la API de tu PC. Se repite cada vez que se desconecta el cable.

### Usuarios de prueba

| Rol | Correo | Clave |
|---|---|---|
| ADMIN | `admin@delicia.pe` | `Admin2026*` |
| EMPLEADO | `luis@delicia.pe` | `Empleado2026*` |
| EMPLEADO | `mia@delicia.pe` | `Empleado2026*` |
| CLIENTE | `ana.cliente@mail.com` | `Cliente2026*` |

> Cambiarlas antes de mostrar la app fuera de clase.

---

## 13. Errores comunes

| Mensaje | Causa | Solución |
|---|---|---|
| `Falta DATABASE_URL` o `Falta JWT_SECRET` | `.env` vacío o en otra carpeta | Completar `.env` en la raíz del proyecto |
| `argument handler must be a function` | Un controlador vacío o con el código de otro | Revisar la línea que indica `routes/index.js` y el archivo correspondiente |
| `relation "usuarios" does not exist` | No se ejecutaron los scripts SQL | Ejecutar `01`, `02`, `03` en Neon |
| `Correo o contraseña incorrectos` | Faltan los usuarios o la clave está mal escrita | Ejecutar `03` y revisar el asterisco final |
| App: `Sin conexión con la API` | La API no corre o falta el puente USB | `npm run dev` y `adb reverse tcp:8000 tcp:8000` |
| `EADDRINUSE :8000` | Ya hay otra API corriendo | Cerrar la otra terminal o cambiar `PORT` |

---

## 14. Publicar en Render

1. Render, **New**, **Web Service**, conectar este repositorio.
2. Build command: `npm install`. Start command: `npm start`.
3. En **Environment**, cargar las mismas variables del `.env`.
4. En el app Android, cambiar `BASE_URL` por `https://<tu-servicio>.onrender.com/`.
5. Agregar el dominio de la web React a `CORS_ORIGINS`.

---

## 15. Glosario

| Término | Significado |
|---|---|
| **API REST** | Programa que recibe peticiones HTTP (GET, POST, PUT, PATCH) y responde con JSON |
| **Endpoint** | Una dirección de la API, por ejemplo `GET /api/pedidos` |
| **Middleware** | Función que se ejecuta antes del controlador (por ejemplo, revisar el token) |
| **Controlador** | Función que atiende una ruta: valida, consulta la base y responde |
| **JWT** | Token firmado que dice quién es el usuario y su rol. Viaja en el header `Authorization` |
| **bcrypt** | Algoritmo para guardar contraseñas de forma que no se puedan leer |
| **Pool** | Grupo de conexiones a la base que se reutilizan |
| **Transacción** | Varias consultas que se guardan juntas o no se guarda ninguna |
| **Idempotencia** | Repetir la misma operación no cambia el resultado (uuid en sincronización) |
| **Webhook** | Llamada que un sistema externo (el banco) hace a tu API para avisar algo |
| **CORS** | Regla del navegador que decide qué webs pueden llamar a la API |
| **MAPE** | Error porcentual promedio del pronóstico frente a lo real |

---

## Tecnologías

Node.js 20+, Express 5, pg (node-postgres), bcryptjs, jsonwebtoken, cors. Base de datos Neon Postgres.
