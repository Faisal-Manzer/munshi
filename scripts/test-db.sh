#!/usr/bin/env bash
# Runs the database checks in supabase/tests/db_checks.sql.
#
# Everything executes inside ONE transaction that ends with ROLLBACK — the
# target database is left untouched, so this is safe against any environment.
#
# Usage:
#   DATABASE_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" npm run test:db
#
# Never commit the connection string anywhere.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a Postgres connection string (it is never stored)}"

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -f "$(cd "$(dirname "$0")/.." && pwd)/supabase/tests/db_checks.sql"

echo "db checks passed — transaction rolled back, database untouched"
