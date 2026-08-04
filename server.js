const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();
const isProduction = process.env.NODE_ENV === "production";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  jwtIssuer: process.env.JWT_ISSUER || "vexardrive-fleet-ping",
  jwtAudience: process.env.JWT_AUDIENCE || "vexardrive-clients",
  jwtExpiry: process.env.JWT_EXPIRY || "15m",
  otpVerifierUrl: process.env.OTP_VERIFIER_URL,
  otpVerifierApiKey: process.env.OTP_VERIFIER_API_KEY,
  otpTestCode: process.env.OTP_TEST_CODE,
};

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  ssl: isProduction ? { rejectUnauthorized: true } : false,
});

function log(level, event, fields = {}) {
  console[level === "error" ? "error" : "log"](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
}

pool.on("error", (error) => log("error", "database_pool_error", { error: error.message }));
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  res.set("x-request-id", requestId);
  res.on("finish", () => log("info", "http_request", { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }));
  next();
});

function authenticate(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!match) return res.status(401).json({ error: "authentication required" });
  try {
    req.auth = jwt.verify(match[1], config.jwtSecret, { algorithms: ["HS256"], issuer: config.jwtIssuer, audience: config.jwtAudience });
    next();
  } catch {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.auth.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}

function validPing(body) {
  const { vehicleId, lat, lng, speed, timestamp } = body || {};
  if (typeof vehicleId !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(vehicleId)) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(speed) || speed < 0 || speed > 400) return null;
  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.getTime())) return null;
  return { vehicleId, lat, lng, speed, timestamp: parsedTimestamp.toISOString() };
}

async function verifyOtp(phone, otp) {
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) return false;
  // This test-only code is deliberately disabled in production.
  if (!isProduction && config.otpTestCode) return otp === config.otpTestCode;
  if (!config.otpVerifierUrl) throw new Error("OTP verifier is not configured");
  const response = await fetch(config.otpVerifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(config.otpVerifierApiKey ? { authorization: `Bearer ${config.otpVerifierApiKey}` } : {}) },
    body: JSON.stringify({ phone, otp }), signal: AbortSignal.timeout(3000),
  });
  return response.ok && (await response.json()).verified === true;
}

app.get("/", (_req, res) => res.json({ service: "fleet-ping", status: "ok" }));
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/readyz", async (_req, res, next) => {
  try { await pool.query("SELECT 1"); res.status(200).json({ status: "ready" }); } catch (error) { next(error); }
});

app.post("/api/fleet/ping", authenticate, async (req, res, next) => {
  const ping = validPing(req.body);
  if (!ping) return res.status(400).json({ error: "invalid ping payload" });
  try {
    await pool.query("INSERT INTO fleet_pings (vehicle_id, lat, lng, speed, ts) VALUES ($1, $2, $3, $4, $5)", [ping.vehicleId, ping.lat, ping.lng, ping.speed, ping.timestamp]);
    res.status(202).json({ status: "accepted" });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  const { phone, otp } = req.body || {};
  if (typeof phone !== "string" || !/^\+?[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: "invalid phone number" });
  try {
    if (!(await verifyOtp(phone, otp))) return res.status(401).json({ error: "invalid credentials" });
    const result = await pool.query("SELECT id FROM drivers WHERE phone = $1", [phone]);
    if (result.rows.length === 0) return res.status(401).json({ error: "invalid credentials" });
    const token = jwt.sign({ driverId: result.rows[0].id, role: "driver" }, config.jwtSecret, { algorithm: "HS256", expiresIn: config.jwtExpiry, issuer: config.jwtIssuer, audience: config.jwtAudience });
    res.json({ token });
  } catch (error) { next(error); }
});

app.get("/api/admin/drivers", authenticate, requireAdmin, async (_req, res, next) => {
  try { res.json((await pool.query("SELECT id, phone, name, created_at FROM drivers ORDER BY id")).rows); } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  log("error", "request_failed", { error: error.message });
  res.status(503).json({ error: "service temporarily unavailable" });
});

let server;
async function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  server?.close(async () => { await pool.end(); log("info", "shutdown_complete"); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}

if (require.main === module) {
  server = app.listen(config.port, "0.0.0.0", () => log("info", "server_started", { port: config.port }));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { app, pool };
