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

  CREATE TABLE IF NOT EXISTS workouts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_type  TEXT    NOT NULL,
    start_time    TEXT    NOT NULL,
    end_time      TEXT,
    start_ts      INTEGER NOT NULL,
    end_ts        INTEGER,
    duration      REAL,
    active_energy REAL,
    distance      REAL,
    distance_unit TEXT,
    source        TEXT,
    received_at   INTEGER NOT NULL,
    UNIQUE(workout_type, start_time)
  );

  CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_ts);

  CREATE TABLE IF NOT EXISTS call_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id      TEXT    NOT NULL UNIQUE,
    phone_number TEXT,
    status       TEXT,
    duration     REAL,
    transcript   TEXT,
    summary      TEXT,
    cost         REAL,
    received_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_call_results_received ON call_results(received_at);

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

// Migrate workouts table: change UNIQUE(workout_type, start_time, source) →
// UNIQUE(workout_type, start_time) so the upsert deduplicates correctly even
// when source is NULL.  Also deduplicates any existing duplicate rows, keeping
// the most recently received copy.
(() => {
  const info = db.prepare(`PRAGMA table_info(workouts)`).all();
  if (info.length === 0) return; // table doesn't exist yet, CREATE TABLE above handles it

  // Check the current unique index definition to see if migration is needed
  const indexes = db.prepare(`PRAGMA index_list(workouts)`).all();
  const needsMigration = indexes.some(idx => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all().map(c => c.name);
    return cols.length === 3 && cols.includes('source');
  });

  if (needsMigration) {
    console.log('[migrate] Rebuilding workouts table with UNIQUE(workout_type, start_time)…');
    db.exec(`
      CREATE TABLE IF NOT EXISTS workouts_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        workout_type  TEXT    NOT NULL,
        start_time    TEXT    NOT NULL,
        end_time      TEXT,
        start_ts      INTEGER NOT NULL,
        end_ts        INTEGER,
        duration      REAL,
        active_energy REAL,
        distance      REAL,
        distance_unit TEXT,
        source        TEXT,
        received_at   INTEGER NOT NULL,
        UNIQUE(workout_type, start_time)
      );

      -- Copy deduplicated rows (keep the one with the highest received_at per group)
      INSERT OR IGNORE INTO workouts_new
        (workout_type, start_time, end_time, start_ts, end_ts,
         duration, active_energy, distance, distance_unit, source, received_at)
      SELECT workout_type, start_time, end_time, start_ts, end_ts,
             duration, active_energy, distance, distance_unit, source, received_at
      FROM workouts
      ORDER BY received_at DESC;

      DROP TABLE workouts;
      ALTER TABLE workouts_new RENAME TO workouts;
      CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_ts);
    `);
    const beforeCount = db.prepare(`SELECT changes() AS c`).get();
    console.log('[migrate] Workouts table rebuilt and deduplicated.');
  }
})();

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

const upsertWorkout = db.prepare(`
  INSERT INTO workouts
    (workout_type, start_time, end_time, start_ts, end_ts,
     duration, active_energy, distance, distance_unit, source, received_at)
  VALUES
    (@workout_type, @start_time, @end_time, @start_ts, @end_ts,
     @duration, @active_energy, @distance, @distance_unit, @source, @received_at)
  ON CONFLICT(workout_type, start_time) DO UPDATE SET
    end_time      = excluded.end_time,
    end_ts        = excluded.end_ts,
    duration      = excluded.duration,
    active_energy = excluded.active_energy,
    distance      = excluded.distance,
    distance_unit = excluded.distance_unit,
    source        = excluded.source,
    received_at   = excluded.received_at
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
 * Ensure a value is a SQLite-bindable primitive (number, string, bigint, Buffer, or null).
 * Health Auto Export sometimes sends objects or arrays where we expect scalars
 * (e.g. source: { name: "Apple Watch", bundleIdentifier: "..." }).
 * - Objects with a `name` property → extract name string
 * - Other objects/arrays → JSON.stringify
 * - Everything else passes through unchanged
 */
function toScalar(val) {
  if (val == null) return null;
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'bigint' || Buffer.isBuffer(val)) {
    return val;
  }
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'object') {
    // Common pattern: source is { name: "Apple Watch", ... }
    if (!Array.isArray(val) && typeof val.name === 'string') return val.name;
    return JSON.stringify(val);
  }
  return String(val);
}

/** Coerce to a number or null — safely handles objects that aren't numeric. */
function toNum(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') { const n = Number(val); return isNaN(n) ? null : n; }
  // If it's an object/array, it's not a valid number
  if (typeof val === 'object') return null;
  return null;
}

/**
 * Ingest a full Health Auto Export payload.
 * Returns { metricsProcessed, readingsInserted, workoutsInserted }
 */
function ingestPayload(payload, rawSize) {
  const now = Math.floor(Date.now() / 1000);

  // Defensively locate the metrics array — support multiple payload shapes
  let metrics = payload?.data?.metrics ?? payload?.metrics ?? null;

  // If a single metric object was passed instead of an array, wrap it
  if (metrics && !Array.isArray(metrics)) {
    metrics = [metrics];
  }

  // Allow workouts-only payloads (metrics can be an empty array)
  const hasWorkouts = Array.isArray(payload?.data?.workouts) || Array.isArray(payload?.workouts);
  if (!Array.isArray(metrics) && !hasWorkouts) {
    throw new Error('Invalid payload: expected metrics array in data.metrics or at top level');
  }
  if (!Array.isArray(metrics)) {
    metrics = [];
  }

  let readingsInserted = 0;
  let workoutsInserted = 0;
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

        const sleepDeep  = entry.deep  ?? null;
        const sleepRem   = entry.rem   ?? null;
        const sleepCore  = entry.core  ?? null;
        const sleepStart = entry.sleepStart ?? null;
        const sleepEnd   = entry.sleepEnd   ?? null;

        // Compute total sleep from stages if the explicit total is missing/zero
        let valueQty = isSleep
          ? (entry.asleep ?? entry.totalSleep ?? entry.qty ?? entry.quantity ?? null)
          : (entry.qty ?? entry.quantity ?? null);
        if (isSleep && (valueQty == null || valueQty === 0)) {
          if (sleepDeep != null || sleepRem != null || sleepCore != null) {
            const computed = (sleepDeep ?? 0) + (sleepRem ?? 0) + (sleepCore ?? 0);
            if (computed > 0) valueQty = computed;
          }
        }

        // Compute sleep_in_bed from the sleep window if inBed not in payload
        let sleepInBed = entry.inBed ?? null;
        if (isSleep && (sleepInBed == null || sleepInBed === 0) && sleepStart && sleepEnd) {
          const startTs = parseHealthDate(sleepStart);
          const endTs   = parseHealthDate(sleepEnd);
          if (startTs && endTs && endTs > startTs) {
            sleepInBed = (endTs - startTs) / 3600; // hours
          }
        }

        upsertReading.run({
          metric_name: toScalar(name),
          units:       toScalar(units),
          date:        toScalar(dateStr),
          date_ts,
          value_min:   toNum(entry.Min ?? entry.min ?? null),
          value_avg:   toNum(entry.Avg ?? entry.avg ?? entry.value ?? null),
          value_max:   toNum(entry.Max ?? entry.max ?? null),
          value_qty:   toNum(valueQty),
          sleep_deep:  toNum(sleepDeep),
          sleep_rem:   toNum(sleepRem),
          sleep_core:  toNum(sleepCore),
          sleep_in_bed: toNum(sleepInBed),
          sleep_start:  toScalar(sleepStart),
          sleep_end:    toScalar(sleepEnd),
          source:       toScalar(entry.source) || null,
          received_at:  now,
        });
        readingsInserted++;
      }
    }

    // Handle workouts from data.workouts or top-level workouts
    const workoutEntries = payload?.data?.workouts ?? payload?.workouts;
    if (Array.isArray(workoutEntries)) {
      for (const entry of workoutEntries) {
        const startStr = entry.start ?? entry.startDate ?? null;
        const endStr   = entry.end   ?? entry.endDate   ?? null;
        const start_ts = parseHealthDate(startStr);
        if (!start_ts || !startStr) continue;

        const workoutType = entry.name ?? entry.workoutActivityType ?? 'Unknown';
        const end_ts      = parseHealthDate(endStr);
        // duration: Health Auto Export sends in seconds; fall back to deriving from timestamps
        let duration = entry.duration ?? null;
        if (duration == null && start_ts && end_ts) {
          duration = end_ts - start_ts;
        }

        // Health Auto Export sends activeEnergy/distance as { qty: N, units: "..." }
        // objects — unwrap to get the numeric value and units separately.
        const aeRaw = entry.activeEnergyBurned ?? entry.activeEnergy ?? entry.totalEnergyBurned ?? null;
        const distRaw = entry.distance ?? null;

        const activeEnergy = (aeRaw && typeof aeRaw === 'object')
          ? toNum(aeRaw.qty ?? aeRaw.quantity ?? null)
          : toNum(aeRaw);

        const distVal = (distRaw && typeof distRaw === 'object')
          ? toNum(distRaw.qty ?? distRaw.quantity ?? null)
          : toNum(distRaw);

        const distUnit = (distRaw && typeof distRaw === 'object')
          ? toScalar(distRaw.units ?? distRaw.unit ?? entry.distanceUnit ?? null)
          : toScalar(entry.distanceUnit ?? null);

        upsertWorkout.run({
          workout_type:  toScalar(workoutType),
          start_time:    toScalar(startStr),
          end_time:      toScalar(endStr) ?? null,
          start_ts,
          end_ts:        end_ts ?? null,
          duration:      toNum(duration),
          active_energy: activeEnergy,
          distance:      distVal,
          distance_unit: distUnit ?? null,
          source:        toScalar(entry.source) ?? null,
          received_at:   now,
        });
        workoutsInserted++;
      }
    }

    logWebhook.run({
      received_at: now,
      payload_size: rawSize,
      metric_names: [...new Set(metricNames)].join(','),
      reading_count: readingsInserted + workoutsInserted,
    });
  });

  ingestAll();

  return { metricsProcessed: metricNames.length, readingsInserted, workoutsInserted };
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
    SELECT r.metric_name, r.units, r.date, r.value_min, r.value_avg, r.value_max, r.value_qty,
           r.sleep_deep, r.sleep_rem, r.sleep_core, r.sleep_in_bed, r.sleep_start, r.sleep_end, r.source
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
      MAX(sleep_start)        AS sleep_start,
      MAX(sleep_end)          AS sleep_end,
      COUNT(*)                AS readings
    FROM metric_readings
    WHERE date_ts >= ?
    GROUP BY metric_name, day
    ORDER BY metric_name, day
  `).all(cutoff);
}

/**
 * Get recent workouts, optionally filtered by type.
 */
function getWorkouts(days = 30, workoutType = null) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  if (workoutType) {
    return db.prepare(`
      SELECT workout_type, start_time, end_time, duration,
             active_energy, distance, distance_unit, source
      FROM workouts
      WHERE start_ts >= ? AND workout_type = ?
      ORDER BY start_ts DESC
    `).all(cutoff, workoutType);
  }
  return db.prepare(`
    SELECT workout_type, start_time, end_time, duration,
           active_energy, distance, distance_unit, source
    FROM workouts
    WHERE start_ts >= ?
    ORDER BY start_ts DESC
  `).all(cutoff);
}

/**
 * Workout summary: daily aggregates per workout type over the last N days.
 */
function getWorkoutSummary(days = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare(`
    SELECT
      workout_type,
      substr(start_time, 1, 10)   AS day,
      COUNT(*)                    AS session_count,
      SUM(duration)               AS total_duration,
      AVG(duration)               AS avg_duration,
      SUM(active_energy)          AS total_calories,
      SUM(distance)               AS total_distance,
      MAX(distance_unit)          AS distance_unit
    FROM workouts
    WHERE start_ts >= ?
    GROUP BY workout_type, day
    ORDER BY day DESC, workout_type
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

const upsertCallResult = db.prepare(`
  INSERT INTO call_results (call_id, phone_number, status, duration, transcript, summary, cost, received_at)
  VALUES (@call_id, @phone_number, @status, @duration, @transcript, @summary, @cost, @received_at)
  ON CONFLICT(call_id) DO UPDATE SET
    status      = excluded.status,
    duration    = excluded.duration,
    transcript  = excluded.transcript,
    summary     = excluded.summary,
    cost        = excluded.cost,
    received_at = excluded.received_at
`);

/**
 * Store a Bland AI post-call webhook payload.
 */
function saveCallResult(payload) {
  const now = Math.floor(Date.now() / 1000);
  const transcript = Array.isArray(payload.transcripts)
    ? payload.transcripts.map(t => `${t.user}: ${t.text}`).join('\n')
    : (payload.concatenated_transcript || null);

  upsertCallResult.run({
    call_id:      payload.call_id || null,
    phone_number: payload.to || null,
    status:       payload.status || payload.queue_status || null,
    duration:     payload.call_length ?? payload.corrected_duration ?? null,
    transcript,
    summary:      payload.summary || null,
    cost:         payload.price ?? null,
    received_at:  now,
  });
}

/**
 * Get recent call results, newest first.
 */
function getCallResults(limit = 50) {
  const cap = Math.min(limit, 200);
  return db.prepare(`
    SELECT call_id, phone_number, status, duration, summary, cost,
           datetime(received_at, 'unixepoch') AS received_at, transcript
    FROM call_results
    ORDER BY received_at DESC
    LIMIT ?
  `).all(cap);
}

/**
 * Get recent webhook ingestion log entries, newest first.
 */
function getWebhookLog(limit = 10) {
  const cap = Math.min(limit, 50);
  return db.prepare(`
    SELECT datetime(received_at, 'unixepoch') AS received_at,
           payload_size, metric_names, reading_count
    FROM webhook_log
    ORDER BY received_at DESC
    LIMIT ?
  `).all(cap);
}

/**
 * Delete all metric readings from a specific source.
 * Pass source="null" to delete entries where source IS NULL.
 * Returns the number of rows deleted.
 */
function deleteBySource(source) {
  if (source === 'null') {
    const result = db.prepare(`DELETE FROM metric_readings WHERE source IS NULL`).run();
    return result.changes;
  }
  const result = db.prepare(`DELETE FROM metric_readings WHERE source = ?`).run(source);
  return result.changes;
}

module.exports = { ingestPayload, getLatest, getMetricByDate, getSummary, listMetrics, getWorkouts, getWorkoutSummary, saveLocation, getLatestLocation, getLocationHistory, saveCallResult, getCallResults, getWebhookLog, deleteBySource };
