#!/usr/bin/env bash
# Deploys the website (product page, releases, public usage stats) to the
# Uberspace host: the code goes to ~/cmd-website, the data (usage.sqlite,
# releases cache) stays in ~/cmd-website-data, and
# https://endtime-instruments.org/cmd is a symlink in the docroot to
# ~/cmd-website/public, served by Apache (plain PHP, no service).
#
# Run by CI (.github/workflows/website.yml) on master; works from a laptop with
# SSH access too. Idempotent.

set -euo pipefail

HOST="${UBERSPACE_HOST:-janoelze@aquila.uberspace.de}"
URL="https://endtime-instruments.org/cmd"

cd "$(dirname "$0")"
for f in lib/*.php public/*.php public/usage/*.php; do php -l "$f" >/dev/null; done

ssh "$HOST" "mkdir -p ~/cmd-website ~/cmd-website-data && chmod 700 ~/cmd-website-data"
rsync -az --delete --exclude deploy.sh ./ "$HOST:cmd-website/"
# The link only once its target exists: a dangling docroot symlink breaks the whole host.
ssh "$HOST" 'ln -sfn ~/cmd-website/public /var/www/virtual/$USER/endtime-instruments.org/cmd'

curl -fsS -o /dev/null "$URL/" && curl -fsS -o /dev/null "$URL/usage/" && echo "website: ok"
