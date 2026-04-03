const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'health.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT    NOT NULL,
    units       TEXT,
    date        TEXT    NOT NULL,
    date_ts     INTEGER NOT NULL,
    value_min   REAL,
    value_avg   REAL,
    value_max   REAL,
    value_qty   REAL,
    source      TEXT,
    received_at INTEGER NOT NULL,
    UNIQUE(metric_name, date, source)
  );

  CREATE INDEX IF NOT EXISTS idx_metric_date ON metric_readings(metric_name, date_ts);
  CREATE INDEX IF NOT EXISTS idx_date_ts     ON metric_readings(date_ts);

  CREATE TABLE IF NOT EXISTS webhook_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  INTEGER NOT NULL,
    payload_size INTEGER,
    metric_names TEXT,
    reading_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS locations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude     REAL    NOT NULL,
    longitude    REAL    NOT NULL,
    accuracy     REAL,
    label        TEXT,
    timestamp    TEXT    NOT NULL,
    timestamp_ts INTEGER,
    created_at   INTEGER
  );

`);

// Migrate: add sleep-specific columns if not present (safe to re-run)
const existingCols = new Set(
  db.prepare('PRAGMA table_info(metric_readings)').all().map(c => c.name)
);
const sleepCols = [
  ['sleep_deep',  'REAL'],
  ['sleep_rem',   'REAL'],
  ['sleep_core',  'REAL'],
  ['sleep_in_bed','REAL'],
  ['sleep_start', 'TEXT'],
  ['sleep_end',   'TEXT'],
];
for (const [col, type] of sleepCols) {
  if (!existingCols.has(col)) {
    db.exec(`ALTER TABLE metric_readings ADD COLUMN ${col} ${type}`);
  }
}

// Migrate: add timestamp_ts to locations if not present (safe to re-run)
const existingLocationCols = new Set(
  db.prepare('PRAGMA table_info(locations)').all().map(c => c.name)
);
if (!existingLocationCols.has('timestamp_ts')) {
  db.exec(`ALTER TABLE locations ADD COLUMN timestamp_ts INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_ts ON locations(timestamp_ts)`);
}
if (!existingLocationCols.has('created_at')) {
  db.exec(`ALTER TABLE locations ADD COLUMN created_at INTEGER`);
}
// Backfill timestamp_ts for any rows that have a parseable timestamp but no timestamp_ts
db.exec(`
  UPDATE locations
  SET timestamp_ts = CAST(strftime('%s', timestamp) AS INTEGER)
  WHERE timestamp_ts IS NULL AND timestamp IS NOT NULL
`);

// Upsert a single reading row
const upsertReading = db.prepare(`
  INSERT INTO metric_readings
    (metric_name, units, date, date_ts,
     value_min, value_avg, value_max, value_qty,
     sleep_deep, sleep_rem, sleep_core, sleep_in_bed, sleep_start, sleep_end,
     source, received_at)
  VALUES
    (@metric_name, @units, @date, @date_ts,
     @value_min, @value_avg, @value_max, @value_qty,
     @sleep_deep, @sleep_rem, @sleep_core, @sleep_in_bed, @sleep_start, @sleep_end,
     @source, @received_at)
  ON CONFLICT(metric_name, date, source) DO UPDATE SET
    value_min   = excluded.value_min,
    value_avg   = excluded.value_avg,
    value_max   = excluded.value_max,
    value_qty   = excluded.value_qty,
    sleep_deep  = excluded.sleep_deep,
    sleep_rem   = excluded.sleep_rem,
    sleep_core  = excluded.sleep_core,
    sleep_in_bed = excluded.sleep_in_bed,
    sleep_start = excluded.sleep_start,
    sleep_end   = excluded.sleep_end,
    units       = excluded.units,
    received_at = excluded.received_at
`);

const logWebhook = db.prepare(`
  INSERT INTO webhook_log (received_at, payload_size, metric_names, reading_count)
  VALUES (@received_at, @payload_size, @metric_names, @reading_count)
`);

/**
 * Parse a Health Auto Export date string to a Unix timestamp (seconds).
 * Format: "2026-03-24 16:20:00 -0700"
 */
function parseHealthDate(dateStr) {
  if (!dateStr) return null;
  // JS Date handles "2026-03-24 16:20:00 -0700" if we replace space before offset
  const normalized = dateStr.replace(/(\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/, '$1$2');
  const ts = new Date(normalized).getTime();
  return isNaN(ts) ? null : Math.floor(ts / 1000);
}

/**
 * Ingest a full Health Auto Export payload.
 * Returns { metricsProcessed, readingsInserted }
 */
function ingestPayload(payload, rawSize) {
  const now = Math.floor(Date.now() / 1000);
  const metrics = payload?.data?.metrics;

  if (!Array.isArray(metrics)) {
    throw new Error('Invalid payload: expected data.metrics array');
  }

  let readingsInserted = 0;
  const metricNames = [];

  const ingestAll = db.transaction(() => {
    for (const metric of metrics) {
      const name = metric.name;
      const units = metric.units || null;
      if (!name || !Array.isArray(metric.data)) continue;

      metricNames.push(name);

      for (const entry of metric.data) {
        const dateStr = entry.date || entry.startDate || null;
        const date_ts = parseHealthDate(dateStr);
        if (!date_ts) continue;

        // Sleep analysis uses different field names than other metrics
        const isSleep = name === 'sleep_analysis';

        // Diagnostic: log sleep entries so we can see the actual payload fields
        if (isSleep && readingsInserted === 0) {
          console.log('[sleep_analysis] sample entry keys:', Object.keys(entry));
          console.log('[sleep_analysis] sample entry:', JSON.stringify(entry));
        }

        upsertReading.run({
          metric_name: name,
          units,
          date: dateStr,
          date_ts,
          value_min:   entry.Min ?? entry.min ?? null,
          value_avg:   entry.Avg ?? entry.avg ?? entry.value ?? null,
          value_max:   entry.Max ?? entry.max ?? null,
          value_qty:   isSleep
            ? (entry.asleep ?? entry.totalSleep ?? entry.qty ?? entry.quantity ?? null)
            : (entry.qty ?? entry.quantity ?? null),
          sleep_deep:   entry.deep   ?? null,
          sleep_rem:    entry.rem    ?? null,
          sleep_core:   entry.core   ?? null,
          sleep_in_bed: entry.inBed  ?? null,
          sleep_start:  entry.sleepStart ?? null,
          sleep_end:    entry.sleepEnd   ?? null,
          source: entry.source || null,
          received_at: now,
        });
        readingsInserted++;
      }
    }

    logWebhook.run({
      received_at: now,
      payload_size: rawSize,
      metric_names: [...new Set(metricNames)].join(','),
      reading_count: readingsInserted,
    });
  });

  ingestAll();

  return { metricsProcessed: metricNames.length, readingsInserted };
}

/**
 * Get the latest reading for every metric (or for a specific metric).
 */
function getLatest(metricName = null) {
  const cols = `metric_name, units, date, value_min, value_avg, value_max, value_qty,
                sleep_deep, sleep_rem, sleep_core, sleep_in_bed, sleep_start, sleep_end, source`;

  if (metricName) {
    return db.prepare(`
      SELECT ${cols}
      FROM metric_readings
      WHERE metric_name = ?
      ORDER BY date_ts DESC
      LIMIT 1
    `).get(metricName);
  }

  return db.prepare(`
    SELECT ${cols}
    FROM metric_readings r
    INNER JOIN (
      SELECT metric_name, MAX(date_ts) AS max_ts
      FROM metric_readings
      GROUP BY metric_name
    ) latest ON r.metric_name = latest.metric_name AND r.date_ts = latest.max_ts
    ORDER BY r.metric_name
  `).all();
}

/**
 * Get readings for a specific metric, optionally filtered by date (YYYY-MM-DD).
 */
function getMetricByDate(metricName, dateStr = null) {
  const cols = `metric_name, units, date, value_min, value_avg, value_max, value_qty,
                sleep_deep, sleep_rem, sleep_core, sleep_in_bed, sleep_start, sleep_end, source`;

  if (dateStr) {
    return db.prepare(`
      SELECT ${cols}
      FROM metric_readings
      WHERE metric_name = ? AND date LIKE ?
      ORDER BY date_ts ASC
    `).all(metricName, `${dateStr}%`);
  }

  return db.prepare(`
    SELECT ${cols}
    FROM metric_readings
    WHERE metric_name = ?
    ORDER BY date_ts DESC
    LIMIT 100
  `).all(metricName);
}

/**
 * 7-day summary: daily aggregates per metric.
 */
function getSummary(days = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare(`
    SELECT
      metric_name,
      units,
      substr(date, 1, 10)     AS day,
      MIN(value_min)          AS day_min,
      AVG(value_avg)          AS day_avg,
      MAX(value_max)          AS day_max,
      SUM(value_qty)          AS day_total,
      AVG(sleep_deep)         AS sleep_deep_avg,
      AVG(sleep_rem)          AS sleep_rem_avg,
      AVG(sleep_core)         AS sleep_core_avg,
      AVG(sleep_in_bed)       AS sleep_in_bed_avg,
      COUNT(*)                AS readings
    FROM metric_readings
    WHERE date_ts >= ?
    GROUP BY metric_name, day
    ORDER BY metric_name, day
  `).all(cutoff);
}

/**
 * List distinct metric names.
 */
function listMetrics() {
  return db.prepare(`
    SELECT metric_name, units, COUNT(*) AS reading_count,
           MAX(date) AS latest_date
    FROM metric_readings
    GROUP BY metric_name
    ORDER BY metric_name
  `).all();
}

const insertLocation = db.prepare(`
  INSERT INTO locations (latitude, longitude, accuracy, label, timestamp, timestamp_ts, created_at)
  VALUES (@latitude, @longitude, @accuracy, @label, @timestamp, @timestamp_ts, @created_at)
`);

/**
 * Store a GPS location fix.
 */
function saveLocation({ latitude, longitude, accuracy = null, label = null, timestamp }) {
  if (latitude == null || longitude == null || !timestamp) {
    throw new Error('latitude, longitude, and timestamp are required');
  }
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) throw new Error('Invalid timestamp');
  const now = Math.floor(Date.now() / 1000);
  insertLocation.run({
    latitude,
    longitude,
    accuracy: accuracy ?? null,
    label: label ?? null,
    timestamp,
    timestamp_ts: Math.floor(ts / 1000),
    created_at: now,
  });
}

/**
 * Get the most recent location entry.
 */
function getLatestLocation() {
  return db.prepare(`
    SELECT id, latitude, longitude, accuracy, label, timestamp, created_at
    FROM locations
    ORDER BY timestamp_ts DESC
    LIMIT 1
  `).get();
}

/**
 * Get location history, optionally limited and filtered by a since date.
 * @param {number} limit - max rows to return (default 10, max 100)
 * @param {string|null} since - ISO date string; only return entries at or after this time
 */
function getLocationHistory(limit = 10, since = null) {
  const cap = Math.min(limit, 100);
  if (since) {
    const sinceTs = Math.floor(new Date(since).getTime() / 1000);
    return db.prepare(`
      SELECT id, latitude, longitude, accuracy, label, timestamp, created_at
      FROM locations
      WHERE timestamp_ts >= ?
      ORDER BY timestamp_ts DESC
      LIMIT ?
    `).all(sinceTs, cap);
  }
  return db.prepare(`
    SELECT id, latitude, longitude, accuracy, label, timestamp, created_at
    FROM locations
    ORDER BY timestamp_ts DESC
    LIMIT ?
  `).all(cap);
}

module.exports = { ingestPayload, getLatest, getMetricByDate, getSummary, listMetrics, saveLocation, getLatestLocation, getLocationHistory };
