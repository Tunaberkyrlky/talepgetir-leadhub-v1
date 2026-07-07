"""
TG-Research 2GIS scraper service (CIS maps backend).

Exposes the SAME async REST job contract as gosom/google-maps-scraper (-web mode) so the worker's
maps adapter reads both identically:
  • POST /api/v1/jobs               {keywords[], lang?, city?}  → {id, status:"pending"}
  • GET  /api/v1/jobs/{id}          → {id, status ∈ pending|working|ok|failed, count}
  • GET  /api/v1/jobs/{id}/download → text/csv (title, category, address, website, phone, …)

Backed by the 2GIS Catalog API (twogis_client). Deployed as its own Railway service `twogis`
reached at http://twogis.railway.internal:8080. Jobs are held in memory (single-instance, like
Gosom's SQLite store); a restart loses in-flight jobs, which is safe — a harvest is maxAttempts:1
and an operator re-runs (idempotent billing + reconciliation make a re-run safe).
"""
import asyncio
import csv
import io
import logging
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import twogis_client

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("twogis.app")

app = FastAPI(title="tg-research 2gis scraper")

# job_id → {status, rows, error, name}. Bounded by MAX_JOBS (drop oldest) to cap memory.
JOBS: "dict[str, dict]" = {}
JOB_ORDER: list[str] = []
MAX_JOBS = int(os.getenv("TWOGIS_MAX_JOBS", "500"))
MAX_KEYWORDS = int(os.getenv("TWOGIS_MAX_KEYWORDS", "20"))
MAX_KEYWORD_LEN = int(os.getenv("TWOGIS_MAX_KEYWORD_LEN", "200"))

CSV_HEADERS = ["input_id", "title", "category", "address", "website", "phone", "latitude", "longitude", "emails"]

# The worker adapter sends lang ('ru'/'kk'/'uz'/…); map to a 2GIS locale.
LANG_TO_LOCALE = {
    "ru": "ru_RU", "kk": "kk_KZ", "kz": "kk_KZ", "uz": "uz_UZ",
    "az": "az_AZ", "ky": "ky_KG", "kg": "ky_KG", "en": "ru_RU",
}


class JobBody(BaseModel):
    keywords: list[str] = []
    lang: str | None = None
    city: str | None = None
    name: str | None = None


def _remember(job_id: str) -> None:
    JOB_ORDER.append(job_id)
    if len(JOB_ORDER) <= MAX_JOBS:
        return
    # Over cap: evict the OLDEST TERMINAL jobs only. Never evict a pending/working scrape the worker
    # is still polling — that would 404 an in-flight job and make the adapter time out to []. If
    # nothing is terminal yet, the store temporarily exceeds the cap rather than corrupting a job.
    removable = len(JOB_ORDER) - MAX_JOBS
    kept: list[str] = []
    for jid in JOB_ORDER:
        if removable > 0 and JOBS.get(jid, {}).get("status") in ("ok", "failed"):
            JOBS.pop(jid, None)
            removable -= 1
        else:
            kept.append(jid)
    JOB_ORDER[:] = kept


async def _run_job(job_id: str, keywords: list[str], locale: str, city: str | None) -> None:
    job = JOBS.get(job_id)
    if job is None:
        return
    job["status"] = "working"
    try:
        rows = await twogis_client.scrape(keywords, locale=locale, city=city)
        job["rows"] = rows
        job["status"] = "ok"
        log.info("job %s ok: %d rows", job_id, len(rows))
    except Exception as exc:  # noqa: BLE001 — any failure marks the job failed (adapter yields [])
        job["status"] = "failed"
        job["error"] = str(exc)
        log.warning("job %s failed: %s", job_id, exc)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/v1/jobs")
async def create_job(body: JobBody) -> dict:
    # Bound fan-out: cap keyword count + length so a single job can't balloon into
    # MAX_KEYWORDS*MAX_PAGES 2GIS calls or retain unbounded strings (internal-DoS hygiene).
    keywords = [k.strip()[:MAX_KEYWORD_LEN] for k in (body.keywords or []) if k and k.strip()][:MAX_KEYWORDS]
    if not keywords:
        raise HTTPException(status_code=400, detail="keywords required")
    locale = LANG_TO_LOCALE.get((body.lang or "ru").lower(), "ru_RU")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "pending", "rows": [], "error": None, "name": body.name}
    _remember(job_id)
    asyncio.create_task(_run_job(job_id, keywords, locale, body.city))
    return {"id": job_id, "status": "pending", "name": body.name}


@app.get("/api/v1/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {"id": job_id, "status": job["status"], "error": job["error"], "count": len(job["rows"])}


@app.get("/api/v1/jobs/{job_id}/download")
async def download(job_id: str) -> PlainTextResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_HEADERS, extrasaction="ignore")
    writer.writeheader()
    for i, row in enumerate(job["rows"]):
        writer.writerow({"input_id": i, **row})
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")
