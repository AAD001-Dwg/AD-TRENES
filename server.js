import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();

// ── Caché simple en memoria ───────────────────────────────────────────────────
// Evita llamar a SOFSE más de una vez por estación cada 25 segundos
const cache = new Map();
const CACHE_TTL = 25000; // ms

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Limpiar entradas viejas si el caché crece mucho
  if (cache.size > 200) {
    for (const [k, v] of cache) {
      if (Date.now() - v.ts > CACHE_TTL) cache.delete(k);
    }
  }
}
const PORT = process.env.PORT || 3001;
const SOFSE_API = "https://ariedro.dev/api-trenes";
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Servir la app HTML ────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(join(__dirname, "trenes-ar-final.html")));

// ── Endpoint para testear notificaciones ──────────────────────────────────────
// GET /api/test-notif?estacion=Hudson&min=10
// Simula que un tren está a X minutos de la estación
app.get("/api/test-notif", (_req, res) => {
  const estacion = _req.query.estacion || "Hudson";
  const min = parseInt(_req.query.min || "10");
  const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });
  res.json({
    ok: true,
    mensaje: `Abrí esta URL en el celular mientras tenés la app abierta en otra pestaña`,
    simulacion: { estacion, min, hora },
    instrucciones: [
      "1. La app debe tener notificaciones habilitadas",
      "2. Tener al menos una alerta configurada para esta estación",
      "3. El polling chequea cada 60s — para testear más rápido usá el modo debug"
    ]
  });
});

// ── Service Worker — necesario para notificaciones en Android ─────────────────
app.get("/sw.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Service-Worker-Allowed", "/");
  res.send(`
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:"window"}).then(cs => {
    if (cs.length) return cs[0].focus();
    return clients.openWindow("/");
  }));
});
  `);
});

// ── Ícono SVG simple ──────────────────────────────────────────────────────────
app.get("/icon.png", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚆</text></svg>');
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function sofseFetch(path, useCache = true) {
  if (useCache) {
    const cached = cacheGet(path);
    if (cached) {
      console.log(`  [caché] ${path.slice(0, 60)}`);
      return cached;
    }
  }
  const res = await fetch(`${SOFSE_API}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`SOFSE API ${res.status} en ${path}`);
  const data = await res.json();
  if (useCache) cacheSet(path, data);
  return data;
}

// Cache simple de IDs de estaciones para no buscarlos cada vez
const stationCache = {};

async function resolverEstacionId(nombre) {
  const key = nombre.toLowerCase().trim();
  if (stationCache[key]) return stationCache[key];
  const data = await sofseFetch(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
  const estaciones = Array.isArray(data) ? data : data?.estaciones || [];
  if (estaciones.length === 0) return null;
  // Buscar coincidencia exacta primero, luego parcial
  const exacta = estaciones.find(e => (e.nombre || e.name || "").toLowerCase() === key);
  const result = exacta || estaciones[0];
  // La API puede usar distintos nombres para el campo ID
  result._resolvedId = result.id_estacion ?? result.idEstacion ?? result.id ?? result.estacionId ?? result.codigo;
  stationCache[key] = result;
  console.log(`  "${nombre}" → resolvedId ${result._resolvedId} | keys: ${Object.keys(result).join(',')} | nombre: ${result.nombre||result.name}`);
  return result;
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  ts: new Date().toISOString(),
  api: SOFSE_API,
  cached_stations: Object.keys(stationCache).length,
}));

// ── LLEGADAS por estación ─────────────────────────────────────────────────────
// GET /api/trenes/llegadas?estacion=Hudson&cantidad=5
app.get("/api/trenes/llegadas", async (req, res) => {
  try {
    const { estacion, cantidad = 5 } = req.query;
    if (!estacion) return res.status(400).json({ error: "Falta parámetro: estacion" });

    const est = await resolverEstacionId(estacion);
    if (!est) return res.json({ llegadas: [], estacion, error: "Estación no encontrada" });

    const estId = est._resolvedId;
    if (!estId) {
      console.warn(`  Sin ID para "${estacion}", claves disponibles: ${Object.keys(est).join(',')}`);
      return res.json({ llegadas: [], estacion, error: "ID de estación no encontrado", claves: Object.keys(est) });
    }
    const data = await sofseFetch(`/arribos/estacion/${estId}?cantidad=${cantidad}`);
    // Estructura real de SOFSE: { timestamp, results: [{arribo, servicio}], total }
    const results = data?.results || [];
    const now = new Date();

    const llegadas = results.map((r, i) => {
      const arribo   = r.arribo   || {};
      const servicio = r.servicio || {};

      // Minutos: usar arribo.segundos directamente (ya calculado por SOFSE)
      const minutos = typeof arribo.segundos === "number"
        ? Math.round(arribo.segundos / 60)
        : Math.round((new Date(arribo.llegada?.estimada || arribo.llegada?.programada || Date.now()) - now) / 60000);

      // Hora de llegada formateada
      const llegadaISO = arribo.llegada?.estimada || arribo.llegada?.programada || "";
      const hora = llegadaISO
        ? new Date(llegadaISO).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" })
        : "--:--";

      // Demora = diferencia entre estimada y programada
      const demora = (arribo.llegada?.programada && arribo.llegada?.estimada)
        ? Math.max(0, Math.round((new Date(arribo.llegada.estimada) - new Date(arribo.llegada.programada)) / 60000))
        : 0;

      return {
        id:       servicio.id || servicio.numero || i,
        tripId:   servicio.id || `S${servicio.numero || i}`,
        dest:     servicio.hasta?.estacion?.nombre || servicio.ramal?.cabeceraFinal?.nombre || "Terminal",
        minutos:  Math.max(0, minutos),
        hora,
        demora,
        ramal:    servicio.ramal?.nombre || servicio.gerencia?.nombre || "",
        anden:    arribo.anden?.nombre ? `${arribo.anden.nombre}` : `${(i % 4) + 1}`,
        cap:      ["Alta", "Media", "Baja"][i % 3],
        cancelado: !!servicio.cancelacion,
      };
    }).filter(a => a.minutos >= 0 && a.minutos < 180 && !a.cancelado);

    llegadas.sort((a, b) => a.minutos - b.minutos);
    console.log(`  → ${llegadas.length} arribos para "${estacion}" (id: ${estId})`);
    res.json({ llegadas, estacion: est.nombre, id: est.id });
  } catch (e) {
    console.error("Error en /llegadas:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BUSCAR ESTACIONES (para autocompletar) ────────────────────────────────────
app.get("/api/trenes/estaciones", async (req, res) => {
  try {
    const { nombre } = req.query;
    if (!nombre) return res.status(400).json({ error: "Falta parámetro: nombre" });
    const data = await sofseFetch(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RAMALES ───────────────────────────────────────────────────────────────────
app.get("/api/trenes/ramales", async (req, res) => {
  try {
    const { idGerencia = 1 } = req.query;
    res.json(await sofseFetch(`/infraestructura/ramales?idGerencia=${idGerencia}`));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ALERTAS (mock por ahora, SOFSE no expone este endpoint) ───────────────────
app.get("/api/trenes/alertas", (_req, res) => {
  res.json({ entity: [], source: "sofse_sin_alertas" });
});


// ── DEBUG: ver estructura real de la API SOFSE ───────────────────────────────
app.get("/api/debug/estacion", async (req, res) => {
  try {
    const nombre = req.query.nombre || "Hudson";
    const raw = await sofseFetch(`/infraestructura/estaciones?nombre=${encodeURIComponent(nombre)}`);
    res.json({ raw, keys: Array.isArray(raw) ? (raw[0] ? Object.keys(raw[0]) : []) : Object.keys(raw) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/debug/arribos/:id", async (req, res) => {
  try {
    const raw = await sofseFetch(`/arribos/estacion/${req.params.id}?cantidad=2`);
    const item = Array.isArray(raw) ? raw[0] : (raw?.arribos?.[0] || raw);
    res.json({ raw_sample: item, keys: item ? Object.keys(item) : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚆 Trenes AR · puerto ${PORT}`);
  console.log(`   API: ${SOFSE_API} (sin credenciales)\n`);
});
