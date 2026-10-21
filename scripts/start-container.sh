#!/bin/sh
set -eu
case "${1:-web}" in
 init)
  pnpm cli migrate
  pnpm cli bootstrap
  if [ "${SEED_DEMO:-false}" = "true" ]; then pnpm cli seed; fi
  ;;
 web) exec pnpm start ;;
 worker) exec pnpm worker ;;
 *) exec "$@" ;;
esac
