import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const GOV_API = "https://apitransporte.buenosaires.gob.ar";
const GTFS_ZIP_URL = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/f74dacd7-63df-4a56-80f5-b1f590c9199d/download";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Mapa stop_id: "nombre normalizado" → stop_id real ────────────────────────
let stopMap = {};
let stopsLoaded = false;

function normalizar(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "").trim();
}

async function cargarStops() {
  try {
    console.log("📥 Descargando GTFS estático...");
    const res = await fetch(GTFS_ZIP_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GTFS ${res.status}`);
    const buf = await res.arrayBuffer();
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(Buffer.from(buf));
    const entry = zip.getEntry("stops.txt");
    if (!entry) throw new Error("stops.txt no encontrado");
    const lines = entry.getData().toString("utf8").split("\n");
    const header = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const idIdx = header.indexOf("stop_id");
    const nameIdx = header.indexOf("stop_name");
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim().replace(/"/g, ""));
      if (cols.length <= Math.max(idIdx, nameIdx)) continue;
      const id = cols[idIdx]; const name = cols[nameIdx];
      if (id && name) { stopMap[normalizar(name)] = id; count++; }
    }
    stopsLoaded = true;
    console.log(`✅ ${count} estaciones cargadas del GTFS`);
  } catch (e) {
    console.warn("⚠️  GTFS falló, usando stop_ids de respaldo:", e.message);
    // IDs de respaldo (del GTFS estático público de Trenes Argentinos)
    stopMap = {
      "constitucion": "93", "avellaneda": "94", "lanus": "95",
      "lomas de zamora": "96", "banfield": "97", "temperley": "98",
      "hudson": "176", "la plata": "107",
      "retiro": "463", "palermo": "401", "belgrano c": "321",
      "nunez": "322", "san isidro": "470", "tigre": "501",
      "once": "293", "caballito": "294", "flores": "295",
      "liniers": "296", "moron": "297", "ituzaingo": "298", "moreno": "299",
      "villa del parque": "550", "el palomar": "551", "merlo": "552",
      "colegiales": "601", "villa urquiza": "602",
      "pompeya": "700", "villa soldati": "701", "gonzalez catan": "702",
    };
    stopsLoaded = true;
  }
}

function resolverStopId(nombre) {
  const norm = normalizar(nombre);
  if (stopMap[norm]) return stopMap[norm];
  for (const [key, id] of Object.entries(stopMap)) {
    if (key.includes(norm) || norm.includes(key)) return id;
  }
  return null;
}

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (_req, res) => res.sendFile(join(__dirname, "trenes-ar-final.html")));

// ── Helper gobierno ───────────────────────────────────────────────────────────
async function govFetch(endpoint, extra = {}) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...extra,
  });
  const res = await fetch(`${GOV_API}${endpoint}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GOV API ${res.status} en ${endpoint}`);
  return res.json();
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({
  status: "ok", ts: new Date().toISOString(),
  creds: !!(CLIENT_ID && CLIENT_SECRET),
  stops_loaded: stopsLoaded, stops_count: Object.keys(stopMap).length,
}));

// ── STOPS (debug) ─────────────────────────────────────────────────────────────
app.get("/api/trenes/stops", (_req, res) =>
  res.json({ loaded: stopsLoaded, count: Object.keys(stopMap).length, stops: stopMap })
);

// ── LLEGADAS: usa tripUpdates y filtra por stop_id ────────────────────────────
// El endpoint /trenes/arrivalDeparture fue discontinuado → da 404 siempre.
// La forma correcta GTFS-RT es bajar tripUpdates y filtrar.
app.get("/api/trenes/llegadas", async (req, res) => {
  try {
    const estacion = req.query.estacion;
    const stopId = resolverStopId(estacion || "");
    if (!stopId) {
      console.warn(`  No se encontró stop_id para "${estacion}"`);
      return res.json({ entity: [], source: "sin_stop_id" });
    }
    console.log(`  "${estacion}" → stop_id ${stopId}`);

    // Traer todos los tripUpdates y filtrar por esta parada
    const data = await govFetch("/trenes/tripUpdates");
    const entities = data?.entity || [];
    const nowSec = Math.floor(Date.now() / 1000);

    // Filtrar los viajes que pasan por esta parada y extraer el tiempo de llegada
    const llegadas = [];
    for (const e of entities) {
      const tu = e.trip_update;
      if (!tu) continue;
      const stus = tu.stop_time_update || [];
      const stu = stus.find(s => String(s.stop_id) === String(stopId));
      if (!stu) continue;
      const arrival = stu.arrival || stu.departure || {};
      const t = arrival.time || arrival.delay;
      if (!t) continue;
      const minutos = Math.round((t - nowSec) / 60);
      if (minutos < -2 || minutos > 120) continue; // ignorar pasados y muy lejanos
      llegadas.push({
        tripId: tu.trip?.trip_id,
        routeId: tu.trip?.route_id,
        minutos,
        hora: new Date(t * 1000).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
        demora: arrival.delay ? Math.round(arrival.delay / 60) : 0,
        stopId,
      });
    }

    // Ordenar por minutos
    llegadas.sort((a, b) => a.minutos - b.minutos);
    console.log(`  → ${llegadas.length} trenes encontrados para ${estacion}`);
    res.json({ entity: llegadas, stop_id: stopId, estacion });
  } catch (e) {
    console.error("Error en /llegadas:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/trenes/posiciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/vehiclePositions")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trenes/alertas", async (_req, res) => {
  try { res.json(await govFetch("/trenes/alerts")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trenes/actualizaciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/tripUpdates")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


// ── DIAGNÓSTICO: prueba todos los endpoints del gobierno ─────────────────────
app.get("/api/diagnostico", async (_req, res) => {
  const endpoints = [
    "/trenes/tripUpdates",
    "/trenes/vehiclePositions",
    "/trenes/alerts",
    "/trenes/arrivalDeparture",
    "/colectivos/tripUpdates",
    "/subtes/tripUpdates",
  ];
  const results = {};
  for (const ep of endpoints) {
    try {
      const params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      const r = await fetch(`${GOV_API}${ep}?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const text = await r.text();
      let preview = text.slice(0, 120);
      results[ep] = { status: r.status, ok: r.ok, preview };
    } catch (e) {
      results[ep] = { status: "ERROR", ok: false, preview: e.message };
    }
  }
  res.json(results);
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚆 Trenes AR Proxy · puerto ${PORT}`);
  console.log(`   Credenciales: ${CLIENT_ID ? "✅" : "❌"}\n`);
  await cargarStops();
});
