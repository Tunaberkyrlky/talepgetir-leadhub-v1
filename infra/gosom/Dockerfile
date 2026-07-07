# Gosom Google Maps scraper — Railway web/server mode.
# Base image bundles Chromium (Playwright), so no browser download at runtime.
# CMD (not a Railway start command) supplies flags so we don't clobber the
# base ENTRYPOINT ["google-maps-scraper"]. -c 1 bounds Chromium memory to avoid
# OOM on a small container; data-folder is a mounted volume so the SQLite job DB
# + CSV outputs survive redeploys. Listens on :8080 ([::]) for Railway private net.
# Called server-to-server at http://gosom.railway.internal:8080 (keep private).
FROM gosom/google-maps-scraper:v1.16.0
# Upstream copies the bundled playwright-go driver under this versioned directory but sets
# PLAYWRIGHT_DRIVER_PATH=/opt. Point at the directory that actually contains node/ + package/
# so runtime jobs do not try the retired Playwright driver CDN URLs.
ENV PLAYWRIGHT_DRIVER_PATH=/opt/ms-playwright-go/1.57.0
CMD ["-web", "-data-folder", "/data", "-addr", ":8080", "-c", "1"]
