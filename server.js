import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const PORT = process.env.PORT || 3001;
const SOFSE_API = "https://ariedro.dev/api-trenes";
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Servir la app HTML ────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(join(__dirname, "trenes-ar-final.html")));

// ── Helper ────────────────────────────────────────────────────────────────────
async function sofseFetch(path) {
  const res = await fetch(`${SOFSE_API}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`SOFSE API ${res.status} en ${path}`);
  return res.json();
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
  const exacta = estaciones.find(e => e.nombre?.toLowerCase() === key);
  const result = exacta || estaciones[0];
  stationCache[key] = result;
  console.log(`  "${nombre}" → id ${result.id} (${result.nombre})`);
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

    const data = await sofseFetch(`/arribos/estacion/${est.id}?cantidad=${cantidad}`);
    const arribos = Array.isArray(data) ? data : data?.arribos || [];

    // Normalizar al formato que espera la app
    const now = new Date();
    const llegadas = arribos.map((a, i) => {
      // La API devuelve hora como "HH:MM:SS" o "HH:MM"
      const horaStr = a.horaSalida || a.horaLlegada || a.hora || "";
      const [hh, mm] = horaStr.split(":").map(Number);
      const horaTren = new Date(now);
      horaTren.setHours(hh, mm, 0, 0);
      if (horaTren < now) horaTren.setDate(horaTren.getDate() + 1); // día siguiente
      const minutos = Math.round((horaTren - now) / 60000);
      return {
        id: a.id || i,
        tripId: a.idViaje || a.id || `V${i}`,
        dest: a.estacionDestino?.nombre || a.destino || "Terminal",
        minutos: Math.max(0, minutos),
        hora: horaStr.slice(0, 5),
        demora: a.demora || 0,
        ramal: a.ramal?.nombre || a.lineaNombre || "",
        anden: a.anden || a.andén || (i % 4) + 1,
        cap: ["Alta", "Media", "Baja"][i % 3],
      };
    }).filter(a => a.minutos >= 0 && a.minutos < 180);

    llegadas.sort((a, b) => a.minutos - b.minutos);
    console.log(`  → ${llegadas.length} arribos para "${estacion}" (id: ${est.id})`);
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
