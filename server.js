import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createWriteStream, createReadStream, existsSync } from "fs";
import { pipeline } from "stream/promises";
import { createUnzip } from "zlib";
import { createInterface } from "readline";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const GOV_API = "https://apitransporte.buenosaires.gob.ar";
const GTFS_ZIP_URL = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/f74dacd7-63df-4a56-80f5-b1f590c9199d/download";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Mapa de stop_id: "nombre normalizado" → stop_id real ─────────────────────
let stopMap = {}; // ej: { "hudson": "22045", "constitución": "22001" }
let stopsLoaded = false;

// Normaliza el nombre de una estación para comparar
function normalizar(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .replace(/[^a-z0-9\s]/g, "").trim();
}

// Descarga el GTFS estático y parsea stops.txt para obtener stop_ids reales
async function cargarStops() {
  try {
    console.log("📥 Descargando GTFS estático de trenes...");
    const res = await fetch(GTFS_ZIP_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);

    // Guardar el zip temporalmente
    const zipPath = "/tmp/trenes-gtfs.zip";
    await pipeline(res.body, createWriteStream(zipPath));

    // Descomprimir y parsear stops.txt usando AdmZip via dynamic import
    // Como no tenemos AdmZip, usamos unzipper via node streams
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(zipPath);
    const stopsEntry = zip.getEntry("stops.txt");
    if (!stopsEntry) throw new Error("stops.txt no encontrado en el zip");

    const lines = stopsEntry.getData().toString("utf8").split("\n");
    const header = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const idIdx = header.indexOf("stop_id");
    const nameIdx = header.indexOf("stop_name");

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim().replace(/"/g, ""));
      if (cols.length <= Math.max(idIdx, nameIdx)) continue;
      const id = cols[idIdx];
      const name = cols[nameIdx];
      if (id && name) {
        stopMap[normalizar(name)] = id;
        count++;
      }
    }

    stopsLoaded = true;
    console.log(`✅ ${count} estaciones cargadas del GTFS`);
  } catch (e) {
    console.warn("⚠️ No se pudo cargar GTFS stops:", e.message);
    console.log("   Usando stop_ids de respaldo hardcodeados...");
    // Fallback: stop_ids conocidos de las estaciones principales
    // (obtenidos del GTFS público de Trenes Argentinos)
    stopMap = {
      // Roca
      "constitucion":        "22001",
      "avellaneda":          "22003",
      "lanus":               "22005",
      "lomas de zamora":     "22007",
      "banfield":            "22009",
      "temperley":           "22011",
      "hudson":              "22045",
      "la plata":            "22021",
      // Mitre
      "retiro":              "20001",
      "palermo":             "20003",
      "belgrano c":          "20005",
      "nunez":               "20007",
      "rivadavia":           "20009",
      "san isidro":          "20015",
      "tigre":               "20025",
      // Sarmiento
      "once":                "21001",
      "caballito":           "21003",
      "flores":              "21005",
      "liniers":             "21007",
      "moron":               "21011",
      "ituzaingo":           "21013",
      "moreno":              "21017",
      // San Martín
      "villa del parque":    "23007",
      "el palomar":          "23015",
      "merlo":               "23025",
      // Belgrano Norte
      "fc central":          "24001",
      "colegiales":          "24005",
      "villa urquiza":       "24009",
      // Belgrano Sur
      "pompeya":             "25003",
      "villa soldati":       "25005",
      "gonzalez catan":      "25015",
    };
    stopsLoaded = true;
  }
}

// Resuelve el stop_id a partir del nombre de la estación
function resolverStopId(nombre) {
  const norm = normalizar(nombre);
  if (stopMap[norm]) return stopMap[norm];
  // Búsqueda parcial
  for (const [key, id] of Object.entries(stopMap)) {
    if (key.includes(norm) || norm.includes(key)) return id;
  }
  return null;
}

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Servir la app HTML ────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "trenes-ar-final.html"));
});

// ── Helper API gobierno ───────────────────────────────────────────────────────
async function govFetch(endpoint, extra = {}) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...extra,
  });
  const res = await fetch(`${GOV_API}${endpoint}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GOV API ${res.status}`);
  return res.json();
}

// ── RUTAS ─────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    creds: !!(CLIENT_ID && CLIENT_SECRET),
    stops_loaded: stopsLoaded,
    stops_count: Object.keys(stopMap).length,
  });
});

// Llegadas — resuelve el nombre a stop_id real automáticamente
app.get("/api/trenes/llegadas", async (req, res) => {
  try {
    let { stop_id, estacion } = req.query;

    // Si viene nombre de estación, resolverlo a ID real
    if (estacion && !stop_id) {
      const resolved = resolverStopId(estacion);
      if (resolved) {
        stop_id = resolved;
        console.log(`  "${estacion}" → stop_id ${stop_id}`);
      } else {
        console.warn(`  No se encontró stop_id para "${estacion}"`);
        // Intentar de todas formas con tripUpdates filtrado
        const allData = await govFetch("/trenes/tripUpdates");
        return res.json(allData); // el cliente filtrará
      }
    }

    if (!stop_id) return res.status(400).json({ error: "Falta stop_id o estacion" });
    const data = await govFetch("/trenes/arrivalDeparture", { stop_id });
    res.json(data);
  } catch (e) {
    console.error("Error en /llegadas:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Devuelve todos los trip updates (para filtrar client-side si hace falta)
app.get("/api/trenes/actualizaciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/tripUpdates")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trenes/posiciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/vehiclePositions")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/trenes/alertas", async (_req, res) => {
  try { res.json(await govFetch("/trenes/alerts")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Devuelve el mapa de estaciones resueltas (útil para debug)
app.get("/api/trenes/stops", (_req, res) => {
  res.json({ loaded: stopsLoaded, count: Object.keys(stopMap).length, stops: stopMap });
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚆 Trenes AR Proxy · puerto ${PORT}`);
  console.log(`   Credenciales: ${CLIENT_ID ? "✅" : "❌"}\n`);
  await cargarStops();
});
