require('dotenv').config();

const express = require('express');
const { ingestPayload, getLatest, getMetricByDate, getSummary, listMetrics } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is required');
  process.exit(1);
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// Health check — unauthenticated so Railway's healthcheck probe passes
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'health-webhook' });
});

// API key auth — checked on every request except the healthcheck above
app.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/**
 * POST /webhook
 * Receives a Health Auto Export JSON payload and stores it.
 */
app.post('/webhook', (req, res) => {
  const raw = req.body;
  if (!raw || !raw.data) {
    return res.status(400).json({ error: 'Invalid payload: expected { data: { metrics: [...] } }' });
  }

  try {
    const rawSize = JSON.stringify(raw).length;
    const result = ingestPayload(raw, rawSize);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Ingest error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /health/metrics
 * List all metric types in the database.
 */
app.get('/health/metrics', (req, res) => {
  res.json(listMetrics());
});

/**
 * GET /health/latest
 * GET /health/latest?metric=heart_rate
 * Latest reading for every metric (or one specific metric).
 */
app.get('/health/latest', (req, res) => {
  const { metric } = req.query;
  const data = getLatest(metric || null);
  if (metric && !data) {
    return res.status(404).json({ error: `No data found for metric: ${metric}` });
  }
  res.json(data);
});

/**
 * GET /health/summary
 * GET /health/summary?days=30
 * Daily aggregates for every metric over the last N days (default 7).
 *
 * Must be defined BEFORE /health/:metric so Express doesn't treat "summary"
 * as a metric name.
 */
app.get('/health/summary', (req, res) => {
  const days = parseInt(req.query.days, 10) || 7;
  if (days < 1 || days > 365) {
    return res.status(400).json({ error: 'days must be between 1 and 365' });
  }
  const data = getSummary(days);
  res.json({ days, data });
});

/**
 * GET /health/:metric
 * GET /health/:metric?date=2026-03-25
 * All readings for a metric, optionally filtered to a specific date.
 *
 * Common metric names: heart_rate, step_count, blood_pressure_systolic,
 *   blood_pressure_diastolic, respiratory_rate, sleep_analysis, active_energy,
 *   body_mass, etc.
 */
app.get('/health/:metric', (req, res) => {
  const { metric } = req.params;
  const { date } = req.query;
  const data = getMetricByDate(metric, date || null);
  if (data.length === 0) {
    return res.status(404).json({ error: `No data found for metric: ${metric}` });
  }
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`health-webhook listening on port ${PORT}`);
});
