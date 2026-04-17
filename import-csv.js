#!/usr/bin/env node
/**
 * import-csv.js — Parse a Health Auto Export CSV and POST to the health webhook.
 *
 * Usage:
 *   node import-csv.js /path/to/HealthAutoExport.csv
 *   node import-csv.js /path/to/HealthAutoExport.zip   # extracts automatically
 *
 * Set API_KEY env var or the hardcoded value below is used.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const WEBHOOK_URL = 'https://health-webhook-production.up.railway.app/webhook';
const API_KEY = process.env.API_KEY || 'b2b98a3aafab0f6634d9d5981f3c6c9753b8934353e1f2be0a3f25e32cb0921c';

// ── Header parser ─────────────────────────────────────────────────────────────
// Health Auto Export CSV headers look like:
//   "Heart Rate [Min] (bpm)"  → baseName="heart rate", qualifier="min"
//   "Sleep Analysis [Deep] (hr)" → baseName="sleep analysis", qualifier="deep"
//   "Active Energy (kcal)"    → baseName="active energy", qualifier=null
function parseHeader(h) {
  const qualMatch = h.match(/\[([^\]]+)\]/);
  const qualifier = qualMatch ? qualMatch[1].toLowerCase().trim() : null;
  const baseName = h
    .replace(/\s*\[[^\]]*\]/g, '')   // strip [...]
    .replace(/\s*\([^)]*\)$/g, '')   // strip trailing (...)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { baseName, qualifier };
}

// ── Base name → metric config ─────────────────────────────────────────────────
// type: 'qty' | 'minmaxavg' | 'sleep' | 'bp'
const BASE_MAP = {
  'active energy':                       { name: 'active_energy',               units: 'kcal',      type: 'qty'       },
  'resting energy':                      { name: 'resting_energy',              units: 'kcal',      type: 'qty'       },
  'basal energy burned':                 { name: 'resting_energy',              units: 'kcal',      type: 'qty'       },
  'step count':                          { name: 'step_count',                  units: 'count',     type: 'qty'       },
  'heart rate':                          { name: 'heart_rate',                  units: 'bpm',       type: 'minmaxavg' },
  'resting heart rate':                  { name: 'resting_heart_rate',          units: 'bpm',       type: 'qty'       },
  'walking heart rate average':          { name: 'walking_heart_rate_average',  units: 'bpm',       type: 'qty'       },
  'heart rate variability':              { name: 'heart_rate_variability_sdnn', units: 'ms',        type: 'qty'       },
  'blood oxygen saturation':             { name: 'blood_oxygen_saturation',     units: '%',         type: 'qty'       },
  'oxygen saturation':                   { name: 'blood_oxygen_saturation',     units: '%',         type: 'qty'       },
  'walking + running distance':          { name: 'walking_running_distance',    units: 'mi',        type: 'qty'       },
  'walking running distance':            { name: 'walking_running_distance',    units: 'mi',        type: 'qty'       },
  'flights climbed':                     { name: 'flights_climbed',             units: 'count',     type: 'qty'       },
  'apple stand hour':                    { name: 'apple_stand_hour',            units: 'hr',        type: 'qty'       },
  'apple stand time':                    { name: 'apple_stand_time',            units: 'min',       type: 'qty'       },
  'apple exercise time':                 { name: 'apple_exercise_time',         units: 'min',       type: 'qty'       },
  'apple move time':                     { name: 'apple_move_time',             units: 'min',       type: 'qty'       },
  'respiratory rate':                    { name: 'respiratory_rate',            units: 'bpm',       type: 'qty'       },
  'body mass':                           { name: 'body_mass',                   units: 'kg',        type: 'qty'       },
  'weight':                              { name: 'body_mass',                   units: 'lb',        type: 'qty'       },
  'lean body mass':                      { name: 'lean_body_mass',              units: 'lb',        type: 'qty'       },
  'body fat percentage':                 { name: 'body_fat_percentage',         units: '%',         type: 'qty'       },
  'body mass index':                     { name: 'body_mass_index',             units: 'count',     type: 'qty'       },
  'sleep analysis':                      { name: 'sleep_analysis',              units: 'hr',        type: 'sleep'     },
  'mindful minutes':                     { name: 'mindful_minutes',             units: 'min',       type: 'qty'       },
  'vo2 max':                             { name: 'vo2_max',                     units: 'ml/kg/min', type: 'qty'       },
  'blood pressure':                      { name: null,                          units: 'mmHg',      type: 'bp'        },
  'cycling distance':                    { name: 'cycling_distance',            units: 'mi',        type: 'qty'       },
  'cycling speed':                       { name: 'cycling_speed',               units: 'mi/hr',     type: 'qty'       },
  'cycling power':                       { name: 'cycling_power',               units: 'watts',     type: 'qty'       },
  'running speed':                       { name: 'running_speed',               units: 'mi/hr',     type: 'qty'       },
  'running power':                       { name: 'running_power',               units: 'watts',     type: 'qty'       },
  'waist circumference':                 { name: 'waist_circumference',         units: 'in',        type: 'qty'       },
  'time in daylight':                    { name: 'time_in_daylight',            units: 'min',       type: 'qty'       },
  'atrial fibrillation burden':          { name: 'atrial_fibrillation_burden',  units: '%',         type: 'qty'       },
  'walking asymmetry percentage':        { name: 'walking_asymmetry_percentage',units: '%',         type: 'qty'       },
  'walking double support percentage':   { name: 'walking_double_support_pct',  units: '%',         type: 'qty'       },
  'walking speed':                       { name: 'walking_speed',               units: 'mi/hr',     type: 'qty'       },
  'walking step length':                 { name: 'walking_step_length',         units: 'in',        type: 'qty'       },
  'water':                               { name: 'water',                       units: 'fl. oz.',   type: 'qty'       },
  'dietary energy':                      { name: 'dietary_energy',              units: 'kcal',      type: 'qty'       },
  'protein':                             { name: 'protein',                     units: 'g',         type: 'qty'       },
  'carbohydrates':                       { name: 'carbohydrates',               units: 'g',         type: 'qty'       },
  'total fat':                           { name: 'total_fat',                   units: 'g',         type: 'qty'       },
  'fiber':                               { name: 'fiber',                       units: 'g',         type: 'qty'       },
  'sugar':                               { name: 'sugar',                       units: 'g',         type: 'qty'       },
  'sodium':                              { name: 'sodium',                      units: 'mg',        type: 'qty'       },
  'caffeine':                            { name: 'caffeine',                    units: 'mg',        type: 'qty'       },
};

// Sleep qualifier → entry field
const SLEEP_FIELD = {
  'total':   'qty',
  'asleep':  'asleep',
  'in bed':  'inBed',
  'core':    'core',
  'deep':    'deep',
  'rem':     'rem',
  'awake':   'awake',
};

// Heart rate qualifier → entry field
const HR_FIELD = {
  'min': 'Min',
  'max': 'Max',
  'avg': 'Avg',
};

// Blood pressure qualifier → metric name
const BP_NAME = {
  'systolic':  'blood_pressure_systolic',
  'diastolic': 'blood_pressure_diastolic',
};

function parseNum(val) {
  if (val == null || val === '' || val === '--') return null;
  const n = parseFloat(val.toString().replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseCSVRow(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const headers = parseCSVRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = fields[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function convertToMetrics(headers, rows) {
  const dateCol = headers.find(h => /^date/i.test(h.trim()));
  if (!dateCol) throw new Error('No date column found in CSV');

  const metricsByName = new Map();
  function getOrCreate(name, units) {
    if (!metricsByName.has(name)) metricsByName.set(name, { name, units, data: [] });
    return metricsByName.get(name);
  }

  // Pre-process headers to build column instructions
  const colInstructions = [];
  for (const h of headers) {
    if (h === dateCol) continue;
    const { baseName, qualifier } = parseHeader(h);
    const meta = BASE_MAP[baseName];
    if (!meta) continue;

    if (meta.type === 'qty') {
      colInstructions.push({ col: h, metricName: meta.name, units: meta.units, field: 'qty' });
    } else if (meta.type === 'minmaxavg') {
      const hrField = qualifier ? HR_FIELD[qualifier] : 'Avg';
      if (hrField) {
        colInstructions.push({ col: h, metricName: meta.name, units: meta.units, field: hrField });
      }
    } else if (meta.type === 'sleep') {
      const sleepField = qualifier ? SLEEP_FIELD[qualifier] : 'qty';
      if (sleepField) {
        colInstructions.push({ col: h, metricName: 'sleep_analysis', units: 'hr', field: sleepField });
      }
    } else if (meta.type === 'bp') {
      const bpName = qualifier ? BP_NAME[qualifier] : null;
      if (bpName) {
        colInstructions.push({ col: h, metricName: bpName, units: 'mmHg', field: 'qty' });
      }
    }
  }

  console.log(`\nMapped ${colInstructions.length} columns to metrics`);

  for (const row of rows) {
    const rawDate = row[dateCol];
    if (!rawDate || rawDate === '--') continue;

    let dateStr = rawDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      dateStr = `${dateStr} 00:00:00 -0700`;
    }

    for (const instr of colInstructions) {
      const val = row[instr.col];
      const n = parseNum(val);
      if (n == null) continue;

      const metric = getOrCreate(instr.metricName, instr.units);
      let entry = metric.data.find(d => d.date === dateStr);
      if (!entry) { entry = { date: dateStr }; metric.data.push(entry); }

      entry[instr.field] = n;
    }
  }

  const metrics = Array.from(metricsByName.values()).filter(m => m.data.length > 0);
  console.log(`Built ${metrics.length} metrics:`);
  for (const m of metrics) {
    console.log(`  ${m.name}: ${m.data.length} rows`);
  }
  return metrics;
}

function postJSON(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        'x-api-key': apiKey,
      },
    };
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

function getJSON(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  let filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node import-csv.js <path-to-csv-or-zip>');
    process.exit(1);
  }

  filePath = path.resolve(filePath);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  let csvPath = filePath;

  if (filePath.endsWith('.zip')) {
    console.log('Extracting zip...');
    const tmpDir = `/tmp/health-import-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o "${filePath}" -d "${tmpDir}"`);
    const csvFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.csv'));
    if (csvFiles.length === 0) throw new Error('No CSV found in zip');
    const mainCsv = csvFiles.find(f => /^HealthAutoExport-/i.test(f))
                 || csvFiles.find(f => !/ecg|route|workout|symptom|medication|state.*mind|heartrate.*notif/i.test(f))
                 || csvFiles[0];
    csvPath = path.join(tmpDir, mainCsv);
    console.log(`Using CSV: ${mainCsv}`);
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const { headers, rows } = parseCSV(content);
  console.log(`Parsed ${rows.length} data rows, ${headers.length} columns`);

  const metrics = convertToMetrics(headers, rows);
  if (metrics.length === 0) {
    console.error('No recognizable metrics found.');
    process.exit(1);
  }

  console.log('\nPOSTing to webhook...');
  const result = await postJSON(WEBHOOK_URL, API_KEY, { metrics });
  console.log(`Response ${result.status}:`, JSON.stringify(result.body, null, 2));

  if (result.status !== 200) process.exit(1);

  console.log('\nVerifying with /health/summary?days=31...');
  const summaryResult = await getJSON(
    'https://health-webhook-production.up.railway.app/health/summary?days=31',
    API_KEY
  );
  const summary = summaryResult.body;
  const metricNames = [...new Set((summary.data || []).map(d => d.metric_name))];
  console.log(`\nSummary: ${metricNames.length} distinct metrics, ${summary.workouts?.length ?? 0} workouts`);
  console.log('Metrics:', metricNames.join(', '));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
