#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/chaz"

# Log startup for debugging
echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] run.sh: starting node trader.js"

cd "/Users/chaz/Documents/Coding Projects/trading-tracker" || {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] run.sh: failed to cd to project dir"
  exit 1
}

exec /opt/homebrew/bin/node "./bot/trader.js" 2>&1
