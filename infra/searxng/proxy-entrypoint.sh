#!/bin/sh
# Runtime proxy injection for SearXNG.
# ROTATING_PROXY is a secret Railway env var; never bake it into the image.
set -eu

configure_rotating_proxy() {
    if [ -z "${ROTATING_PROXY:-}" ]; then
        return 0
    fi

    src="${TG_SEARXNG_BASE_SETTINGS:-${__SEARXNG_CONFIG_PATH:-/etc/searxng}/settings.yml}"
    dst="${TG_SEARXNG_GENERATED_SETTINGS:-/tmp/tg-searxng-settings.yml}"

    if [ ! -f "$src" ]; then
        echo "SearXNG settings file not found; cannot inject ROTATING_PROXY" >&2
        exit 127
    fi

    proxy="$(printf '%s' "$ROTATING_PROXY" | tr -d '\r\n')"
    if [ -z "$proxy" ]; then
        return 0
    fi
    case "$proxy" in
        *://*) ;;
        *) proxy="http://$proxy" ;;
    esac

    umask 077
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"

    # YAML single-quoted scalar escaping: a literal ' becomes ''.
    escaped_proxy="$(printf '%s' "$proxy" | sed "s/'/''/g")"
    cat >>"$dst" <<EOF

# Generated at container start by infra/searxng/proxy-entrypoint.sh.
outgoing:
  request_timeout: ${SEARXNG_OUTGOING_REQUEST_TIMEOUT:-15.0}
  max_request_timeout: ${SEARXNG_OUTGOING_MAX_REQUEST_TIMEOUT:-30.0}
  retries: ${SEARXNG_OUTGOING_RETRIES:-1}
  extra_proxy_timeout: ${SEARXNG_EXTRA_PROXY_TIMEOUT:-10}
  proxies:
    all://:
      - '$escaped_proxy'
EOF
    chmod 600 "$dst"
    export SEARXNG_SETTINGS_PATH="$dst"
}

configure_rotating_proxy

if [ "${TG_SEARXNG_CONFIG_ONLY:-0}" = "1" ]; then
    exit 0
fi

exec /usr/local/searxng/entrypoint.sh "$@"
