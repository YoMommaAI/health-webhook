# Health Webhook

A lightweight REST API that receives Apple Health data from the **Health Auto Export** iOS app and stores it in SQLite. Designed for deployment on Railway.

## Endpoints

All requests require either:
- Header: `X-API-Key: <your-key>`
- Query param: `?api_key=<your-key>`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check / connectivity test |
| `POST` | `/webhook` | Ingest a Health Auto Export payload |
| `GET` | `/health/metrics` | List all metric types in the database |
| `GET` | `/health/latest` | Latest reading for every metric |
| `GET` | `/health/latest?metric=heart_rate` | Latest reading for one metric |
| `GET` | `/health/summary` | Daily aggregates for the last 7 days |
| `GET` | `/health/summary?days=30` | Daily aggregates for the last N days |
| `GET` | `/health/heart_rate` | All readings for a metric (last 100) |
| `GET` | `/health/step_count?date=2026-03-25` | Readings for a metric on a specific date |

---

## Deploy to Railway

### 1. Create the Railway project

```bash
# Install Railway CLI if needed
npm install -g @railway/cli

railway login
railway init          # creates a new project
railway up            # deploys from the current directory
```

Or connect via the Railway dashboard: https://railway.app → New Project → Deploy from GitHub repo.

### 2. Add a persistent volume

In the Railway dashboard:
1. Open your service → **Volumes** tab
2. Click **Add Volume**
3. Set mount path to `/data`

This ensures the SQLite database survives redeploys.

### 3. Set environment variables

In the Railway dashboard → your service → **Variables**:

```
API_KEY=<generate with: openssl rand -hex 32>
DB_PATH=/data/health.db
```

Railway sets `PORT` automatically — don't set it manually.

### 4. Note your public URL

After deploy, Railway gives you a URL like `https://health-webhook-production.up.railway.app`.

---

## Configure Health Auto Export (iOS)

1. Open **Health Auto Export** on your iPhone
2. Tap **Export** → **Automations** (or **REST API** depending on your version)
3. Set up a new **REST API** destination:
   - **URL**: `https://<your-railway-url>/webhook`
   - **Method**: `POST`
   - **Headers**: `X-API-Key: <your-api-key>`
   - **Format**: JSON
4. Select the metrics you want to sync (steps, heart rate, sleep, workouts, etc.)
5. Set the export frequency (e.g., hourly or daily)

**Tip**: Use the "Test" button in Health Auto Export to send a sample payload and verify the connection. A successful response looks like:
```json
{"ok": true, "metricsProcessed": 5, "readingsInserted": 142}
```

---

## Run locally

```bash
cp .env.example .env
# Edit .env and set API_KEY

npm install
npm start
# Server runs on http://localhost:3000
```

Test with curl:
```bash
# Health check
curl -H "X-API-Key: your-key" http://localhost:3000/

# Send a test payload
curl -X POST http://localhost:3000/webhook \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "metrics": [
        {
          "name": "heart_rate",
          "units": "count/min",
          "data": [
            {"Min": 58, "Avg": 72, "Max": 145, "date": "2026-03-25 09:00:00 -0700", "source": "Vaughn'\''s Apple Watch"}
          ]
        },
        {
          "name": "step_count",
          "units": "count",
          "data": [
            {"qty": 8432, "date": "2026-03-25 00:00:00 -0700", "source": "Vaughn'\''s Apple Watch"}
          ]
        }
      ]
    }
  }'

# Query latest data
curl -H "X-API-Key: your-key" http://localhost:3000/health/latest

# Steps on a specific date
curl -H "X-API-Key: your-key" "http://localhost:3000/health/step_count?date=2026-03-25"

# 7-day summary
curl -H "X-API-Key: your-key" http://localhost:3000/health/summary
```

---

## Data model

Readings are stored with these fields per entry:

| Field | Description |
|-------|-------------|
| `metric_name` | e.g. `heart_rate`, `step_count` |
| `units` | e.g. `count/min`, `count` |
| `date` | Original date string from the app |
| `value_min` | Minimum value (from `Min` field) |
| `value_avg` | Average value (from `Avg` or `value` field) |
| `value_max` | Maximum value (from `Max` field) |
| `value_qty` | Quantity/total (from `qty` field — used by steps, calories, etc.) |
| `source` | Device name, e.g. `Vaughn's Apple Watch` |

Duplicate readings (same metric + date + source) are upserted — re-sending the same export is safe.

---

## Common Health Auto Export metric names

| App metric | Database `metric_name` |
|-----------|------------------------|
| Heart Rate | `heart_rate` |
| Step Count | `step_count` |
| Active Energy | `active_energy` |
| Resting Heart Rate | `resting_heart_rate` |
| Heart Rate Variability | `heart_rate_variability_sdnn` |
| Respiratory Rate | `respiratory_rate` |
| Blood Oxygen | `oxygen_saturation` |
| Sleep Analysis | `sleep_analysis` |
| Body Mass | `body_mass` |
| Blood Pressure (systolic) | `blood_pressure_systolic` |
| Blood Pressure (diastolic) | `blood_pressure_diastolic` |
| VO2 Max | `vo2_max` |
