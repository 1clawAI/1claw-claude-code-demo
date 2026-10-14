#!/usr/bin/env bash
# Launch Claude Code as the Pipeline buyer, with ONLY the buyer's 1Claw identity.
set -euo pipefail
cd "$(dirname "$0")/buyer"
[ -f .env ] || { echo "buyer/.env missing — run: npm run bootstrap"; exit 1; }
set -a; source .env; set +a
exec claude "${@:-You are Pipeline. Run your opening checklist from CLAUDE.md.}"
