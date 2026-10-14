#!/usr/bin/env bash
# Launch Claude Code as the LeadForge seller, with ONLY the seller's 1Claw identity.
set -euo pipefail
cd "$(dirname "$0")/seller"
[ -f .env ] || { echo "seller/.env missing — run: npm run bootstrap"; exit 1; }
set -a; source .env; set +a
exec claude "${@:-You are LeadForge. Run your opening checklist from CLAUDE.md.}"
