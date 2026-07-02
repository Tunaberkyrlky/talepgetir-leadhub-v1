# SearXNG for TG-Research — Railway private service, JSON API enabled.
# The official image runs Granian bound to [::]:8080 (Railway private-net ready),
# and its entrypoint keeps a pre-baked /etc/searxng/settings.yml. We bake ours in
# to enable search.formats:[html,json] (no env var exists for that). 977:977 is the
# image's searxng user/group. Reached at http://searxng.railway.internal:8080.
# NOTE: pin a dated tag (e.g. searxng/searxng:2026.x.y) once integrated; :latest
# is used now because this service is idle until discovery is wired to it.
FROM searxng/searxng:latest
COPY --chown=977:977 settings.yml /etc/searxng/settings.yml
