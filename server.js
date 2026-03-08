import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const GOV_API = "https://apitransporte.buenosaires.gob.ar";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn("⚠️  Faltan CLIENT_ID o CLIENT_SECRET en variables de entorno");
}

// ── CORS: acepta cualquier origen (podés restringirlo a tu dominio) ────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Helper ────────────────────────────────────────────────────────────────────
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

// ── Rutas ─────────────────────────────────────────────────────────────────────

// Salud del servidor
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), creds: !!(CLIENT_ID && CLIENT_SECRET) });
});

// Llegadas por parada
app.get("/api/trenes/llegadas", async (req, res) => {
  try {
    const { stop_id } = req.query;
    if (!stop_id) return res.status(400).json({ error: "Falta stop_id" });
    res.json(await govFetch("/trenes/arrivalDeparture", { stop_id }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Posiciones de vehículos
app.get("/api/trenes/posiciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/vehiclePositions")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Alertas
app.get("/api/trenes/alertas", async (_req, res) => {
  try { res.json(await govFetch("/trenes/alerts")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Trip updates
app.get("/api/trenes/actualizaciones", async (_req, res) => {
  try { res.json(await govFetch("/trenes/tripUpdates")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n🚆 Trenes AR Proxy · http://localhost:${PORT}`);
  console.log(`   Credenciales: ${CLIENT_ID ? "✅" : "❌"}\n`);
});
