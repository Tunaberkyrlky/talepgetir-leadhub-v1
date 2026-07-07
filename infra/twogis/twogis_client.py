"""
2GIS Catalog API client (TG-Research maps backend, CIS).

Robust HTTP+JSON path (NOT Selenium HTML scraping): the 2GIS Catalog API 3.0 returns each firm's
name, address, website, phone and coordinates directly, so the brittle hashed-CSS scraping the
reference repo (iqbalmdkaify/2GIS-data-scraper) relied on is avoided. Requires a 2GIS API key
(free tier at https://dev.2gis.com) in TWOGIS_API_KEY.

Returns rows shaped for the Gosom-compatible CSV the TG-Research worker parses (title, website,
phone, address, category, latitude, longitude, emails), so the same TS adapter reads both backends.
"""
import asyncio
import logging
import os

import httpx

CATALOG_URL = os.getenv("TWOGIS_CATALOG_URL", "https://catalog.api.2gis.com/3.0/items")
API_KEY = os.getenv("TWOGIS_API_KEY", "").strip()
PAGE_SIZE = int(os.getenv("TWOGIS_PAGE_SIZE", "10"))
MAX_PAGES = int(os.getenv("TWOGIS_MAX_PAGES", "5"))
REQUEST_DELAY_SEC = float(os.getenv("TWOGIS_REQUEST_DELAY_SEC", "0.4"))
HTTP_TIMEOUT_SEC = float(os.getenv("TWOGIS_HTTP_TIMEOUT_SEC", "30"))
# Fields to request — contact_groups carries website + phone; rubrics = category.
FIELDS = "items.point,items.address,items.full_address_name,items.contact_groups,items.rubrics"

log = logging.getLogger("twogis.client")


class TwoGisError(Exception):
    """Raised for configuration/hard errors so the job is marked failed (adapter then yields [])."""


def _extract_contacts(item: dict) -> tuple[str, str, str]:
    """Pull (website, phone, emails-csv) out of a 2GIS item's contact_groups."""
    website = ""
    phone = ""
    emails: list[str] = []
    for group in item.get("contact_groups") or []:
        for c in group.get("contacts") or []:
            ctype = c.get("type")
            value = c.get("value") or c.get("url") or c.get("text") or ""
            if not value:
                continue
            if ctype == "website" and not website:
                website = value
            elif ctype == "phone" and not phone:
                phone = value
            elif ctype == "email":
                emails.append(value)
    return website, phone, ",".join(emails)


def _row_from_item(item: dict) -> dict:
    website, phone, emails = _extract_contacts(item)
    rubrics = item.get("rubrics") or []
    category = rubrics[0].get("name", "") if rubrics else ""
    point = item.get("point") or {}
    return {
        "title": item.get("name") or "",
        "category": category,
        "address": item.get("full_address_name") or item.get("address_name") or "",
        "website": website,
        "phone": phone,
        "latitude": str(point.get("lat", "") or ""),
        "longitude": str(point.get("lon", "") or ""),
        "emails": emails,
    }


async def _search_keyword(client: httpx.AsyncClient, keyword: str, locale: str, city: str | None) -> list[dict]:
    """Page through the Catalog API for one keyword; returns normalized rows (never raises for a
    per-page error — logs + stops that keyword, mirroring the never-throws discovery contract)."""
    q = f"{keyword} {city}".strip() if city else keyword
    rows: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        params = {
            "q": q,
            "page": page,
            "page_size": PAGE_SIZE,
            "fields": FIELDS,
            "locale": locale,
            "key": API_KEY,
        }
        try:
            resp = await client.get(CATALOG_URL, params=params, timeout=HTTP_TIMEOUT_SEC)
        except Exception as exc:  # network/timeout — stop this keyword, keep what we have
            log.warning("2gis request error for %r page %s: %s", q, page, exc)
            break
        if resp.status_code != 200:
            log.warning("2gis http %s for %r page %s", resp.status_code, q, page)
            break
        data = resp.json()
        meta = data.get("meta") or {}
        code = meta.get("code")
        if code != 200:
            # 404 = no (more) results, the normal end of pagination; other codes are real errors.
            if code != 404:
                log.warning("2gis meta code %s for %r: %s", code, q, meta.get("error"))
            break
        items = (data.get("result") or {}).get("items") or []
        if not items:
            break
        rows.extend(_row_from_item(it) for it in items)
        if len(items) < PAGE_SIZE:
            break  # last page
        await asyncio.sleep(REQUEST_DELAY_SEC)
    return rows


async def scrape(keywords: list[str], locale: str = "ru_RU", city: str | None = None) -> list[dict]:
    """Run the 2GIS search for each keyword and return the combined rows. Raises TwoGisError only
    for a missing API key (a hard config error); per-keyword failures degrade to fewer rows."""
    if not API_KEY:
        raise TwoGisError("TWOGIS_API_KEY is not set — get a free key at https://dev.2gis.com")
    out: list[dict] = []
    async with httpx.AsyncClient() as client:
        for kw in keywords:
            out.extend(await _search_keyword(client, kw, locale, city))
            await asyncio.sleep(REQUEST_DELAY_SEC)
    return out
