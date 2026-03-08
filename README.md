# 🚆 Trenes AR — Proxy Server

Servidor intermediario que resuelve el bloqueo CORS de la API del gobierno de Buenos Aires.

## ¿Por qué existe este proxy?

La API de transporte de Buenos Aires solo acepta llamadas desde servidores, no desde navegadores. Este proxy actúa de intermediario:

```
Tu app (celular) → Este servidor (Render) → API del Gobierno ✅
```

## Deploy en Render (gratis, sin tarjeta)

### Paso 1 — Subir a GitHub

1. Creá un repositorio nuevo en [github.com](https://github.com/new)
   - Nombre sugerido: `trenes-ar-proxy`
   - Visibilidad: **Public** o Private (ambas funcionan)
2. Subí estos 3 archivos: `server.js`, `package.json`, `.env.example`

### Paso 2 — Crear cuenta en Render

1. Entrá a [render.com](https://render.com)
2. Registrate con tu cuenta de GitHub (botón "Sign up with GitHub")

### Paso 3 — Crear el Web Service

1. En el dashboard de Render → **New +** → **Web Service**
2. Conectá tu repositorio `trenes-ar-proxy`
3. Completá la configuración:
   | Campo | Valor |
   |---|---|
   | Name | `trenes-ar-proxy` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Plan | **Free** |

### Paso 4 — Agregar variables de entorno

En la sección **Environment** → **Add Environment Variable**:

| Key | Value |
|---|---|
| `CLIENT_ID` | tu client_id de la API |
| `CLIENT_SECRET` | tu client_secret de la API |

> Conseguí tus credenciales en: https://api-transporte.buenosaires.gob.ar/registro

### Paso 5 — Deploy

1. Hacé click en **Create Web Service**
2. Esperá ~2 minutos mientras Render instala todo
3. Tu URL quedará así: `https://trenes-ar-proxy.onrender.com`

### Paso 6 — Configurar la app

1. Abrí la app Trenes AR en tu celular
2. Tocá el botón de estado (arriba a la derecha)
3. En el campo **URL del servidor** pegá tu URL de Render
4. Guardá → la app se conecta en tiempo real 🎉

## Endpoints disponibles

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/trenes/llegadas?stop_id=X` | Llegadas por estación |
| GET | `/api/trenes/posiciones` | Posición de vehículos |
| GET | `/api/trenes/alertas` | Alertas de servicio |
| GET | `/api/trenes/actualizaciones` | Trip updates |

## ⚠️ Nota sobre el plan gratuito de Render

El servidor "duerme" después de 15 minutos sin uso. La primera llamada después de ese período tarda ~30 segundos en responder (arranque en frío). Las siguientes son instantáneas.
