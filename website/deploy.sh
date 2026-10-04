#!/usr/bin/env bash
# Deploys the website (product page, releases, public usage stats) to the
# Uberspace host: public/ goes to the docroot as
# https://endtime-instruments.org/cmd (Apache serves it directly; plain PHP, no
# service; _lib/ is denied to the web), and the data (usage.sqlite, releases
# cache) stays in ~/cmd-website-data. The docroot holds real files, not a link
# into the home folder: Apache can't enter ~ (mode 700) and answers 403.
#
# Run by CI (.github/workflows/website.yml) on master; works from a laptop with
# SSH access too. Idempotent.

set -euo pipefail

HOST="${UBERSPACE_HOST:-janoelze@aquila.uberspace.de}"
DOCROOT="/var/www/virtual/janoelze/endtime-instruments.org/cmd"
URL="https://endtime-instruments.org/cmd"

cd "$(dirname "$0")"
for f in public/*.php public/_lib/*.php public/usage/*.php; do php -l "$f" >/dev/null; done

# The first deploys linked the docroot to ~/cmd-website; replace that link.
ssh "$HOST" "mkdir -p ~/cmd-website-data && chmod 700 ~/cmd-website-data && { [ ! -L $DOCROOT ] || rm $DOCROOT; } && rm -rf ~/cmd-website && mkdir -p $DOCROOT"
rsync -az --delete public/ "$HOST:$DOCROOT/"

curl -fsS -o /dev/null "$URL/" && curl -fsS -o /dev/null "$URL/usage/" && echo "website: ok"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/_lib/db.php")
[ "$code" = 403 ] || { echo "website: _lib is served (HTTP $code)" >&2; exit 1; }
