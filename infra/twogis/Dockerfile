# TG-Research 2GIS scraper service (CIS maps backend).
# Gosom-compatible REST job API backed by the 2GIS Catalog API. Deployed as Railway service `twogis`.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py twogis_client.py ./

ENV PORT=8080
EXPOSE 8080

# Railway injects $PORT; bind to it (fallback 8080 for local runs).
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
