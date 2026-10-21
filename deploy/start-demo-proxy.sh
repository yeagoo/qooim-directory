#!/bin/sh
set -eu
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
proxy=$!
trap 'kill "$proxy"; wait "$proxy"' TERM INT
# Share only the public CA certificate, never the CA private key.
while [ ! -s /data/caddy/pki/authorities/local/root.crt ]; do
 kill -0 "$proxy"
 sleep 1
done
cp /data/caddy/pki/authorities/local/root.crt /trust/root.crt
chmod 644 /trust/root.crt
wait "$proxy"
