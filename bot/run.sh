#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/chaz"
cd "/Users/chaz/Documents/Coding Projects/trading-tracker"
exec /opt/homebrew/bin/node "/Users/chaz/Documents/Coding Projects/trading-tracker/bot/trader.js" 2>&1
