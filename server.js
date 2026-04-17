require('dotenv').config();

const express = require('express');
const { ingestPayload, getLatest, getMetricByDate, getSummary, listMetrics, getWorkouts, getWorkoutSummary, saveLocation, getLatestLocation, getLocationHistory, saveCallResult, getCallResults, getWebhookLog, deleteBySource } = require('./db');

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

/**
 * POST /bland/webhook
 * Receives Bland AI post-call payloads. No auth — Bland can't send our API key.
 * Stores results in the call_results SQLite table.
 */
app.post('/bland/webhook', (req, res) => {
  const payload = req.body || {};
  if (!payload.call_id) {
    return res.status(400).json({ error: 'Missing call_id in payload' });
  }
  try {
    saveCallResult(payload);
    console.log(`[bland] stored result for call ${payload.call_id} (status: ${payload.status || payload.queue_status})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[bland] webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
 * GET /bland/calls
 * Retrieve stored Bland AI call results. Requires API key auth.
 * Optional query param: ?limit=N (max 200, default 50)
 */
app.get('/bland/calls', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  if (limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'limit must be between 1 and 200' });
  }
  res.json(getCallResults(limit));
});

/**
 * POST /webhook
 * Receives a Health Auto Export JSON payload and stores it.
 *
 * Accepts multiple payload shapes the app has used over time:
 *   1. { data: { metrics: [...], workouts: [...] } }   ← original format
 *   2. { metrics: [...], workouts: [...] }              ← newer flat format
 *   3. { data: { metrics: { ... } } }                  ← single-metric object
 *   4. { metrics: { ... } }                            ← single-metric flat
 *
 * We normalize everything into shape #1 before handing off to ingestPayload.
 */
app.post('/webhook', (req, res) => {
  const raw = req.body;
  if (!raw) {
    return res.status(400).json({ error: 'Empty payload' });
  }

  console.log(`[webhook] received payload (${JSON.stringify(raw).length} bytes)`);

  // ── Normalize into { data: { metrics: [...], workouts: [...] } } ──────────
  let normalized = raw;

  // If there's no `data` wrapper but there IS a top-level `metrics` key, wrap it
  if (!raw.data && (raw.metrics !== undefined || raw.workouts !== undefined)) {
    normalized = { data: { metrics: raw.metrics, workouts: raw.workouts } };
  }

  // At this point we need normalized.data to exist with something to ingest
  if (!normalized.data) {
    return res.status(400).json({ error: 'Invalid payload: expected metrics array in data.metrics or at top level' });
  }

  // If metrics is a single object instead of an array, wrap it
  if (normalized.data.metrics && !Array.isArray(normalized.data.metrics)) {
    normalized.data.metrics = [normalized.data.metrics];
  }

  // If metrics is missing entirely but workouts exist, default to empty array
  if (!normalized.data.metrics && normalized.data.workouts) {
    normalized.data.metrics = [];
  }

  try {
    const rawSize = JSON.stringify(raw).length;
    const result = ingestPayload(normalized, rawSize);
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
 * GET /health/webhook-log
 * Recent webhook ingestion history — shows when data was last received.
 * Optional ?limit=N (max 50, default 10).
 */
/**
 * DELETE /health/cleanup-source?source=Health+Auto+Export+CSV
 * Remove all metric readings from a specific source (e.g. to clean up duplicate imports).
 */
app.delete('/health/cleanup-source', (req, res) => {
  const { source } = req.query;
  if (!source) {
    return res.status(400).json({ error: 'source query parameter is required' });
  }
  const deleted = deleteBySource(source);
  console.log(`[cleanup] deleted ${deleted} readings with source="${source}"`);
  res.json({ ok: true, deleted });
});

app.get('/health/webhook-log', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  res.json(getWebhookLog(limit));
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
  const workouts = getWorkoutSummary(days);
  res.json({ days, data, workouts });
});

/**
 * GET /health/workouts
 * GET /health/workouts?days=30&type=Running
 * Individual workout sessions over the last N days (default 30).
 */
app.get('/health/workouts', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  if (days < 1 || days > 365) {
    return res.status(400).json({ error: 'days must be between 1 and 365' });
  }
  const { type } = req.query;
  const data = getWorkouts(days, type || null);
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

/**
 * POST /location
 * Store a GPS location fix from an iOS Shortcut.
 * Body: { latitude, longitude, accuracy?, label?, timestamp }
 */
app.post('/location', (req, res) => {
  const { latitude, longitude, accuracy, label, timestamp } = req.body || {};
  if (latitude == null || longitude == null || !timestamp) {
    return res.status(400).json({ error: 'latitude, longitude, and timestamp are required' });
  }
  try {
    saveLocation({ latitude, longitude, accuracy, label, timestamp });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /location/latest
 * Most recent location entry.
 */
app.get('/location/latest', (req, res) => {
  const data = getLatestLocation();
  if (!data) {
    return res.status(404).json({ error: 'No location data found' });
  }
  res.json(data);
});

/**
 * GET /location/history
 * GET /location/history?limit=10&since=2026-04-01
 * Recent location history. limit max 100, default 10.
 */
app.get('/location/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const { since } = req.query;
  if (since && isNaN(new Date(since).getTime())) {
    return res.status(400).json({ error: 'Invalid since date' });
  }
  const data = getLocationHistory(limit, since || null);
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`health-webhook listening on port ${PORT}`);
});
