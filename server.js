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
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn("⚠️  Faltan CLIENT_ID o CLIENT_SECRET en variables de entorno");
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Servir la app HTML ────────────────────────────────────────────────────────
// Al abrir https://ad-trenes.onrender.com/ → muestra la app directamente
// Esto también habilita HTTPS → las notificaciones del navegador funcionan
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "trenes-ar-final.html"));
});

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

// ── Rutas API ─────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), creds: !!(CLIENT_ID && CLIENT_SECRET) });
});

app.get("/api/trenes/llegadas", async (req, res) => {
  try {
    const { stop_id } = req.query;
    if (!stop_id) return res.status(400).json({ error: "Falta stop_id" });
    res.json(await govFetch("/trenes/arrivalDeparture", { stop_id }));
  } catch (e) {
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

app.listen(PORT, () => {
  console.log(`\n🚆 Trenes AR · https://ad-trenes.onrender.com`);
  console.log(`   Credenciales: ${CLIENT_ID ? "✅" : "❌"}\n`);
});

