#!/bin/sh
# Ends a closed tab's parked terminal once the reopen window has passed.
# Usage: reap.sh <seconds> <token-file> <token> <terminal>
# Skips the kill if the tab was reopened (terminal is on screen again) or
# closed again later (a newer token owns it).
PATH="$HOME/.local/bin:$PATH"
sleep "$1"
[ "$(cat "$2" 2>/dev/null)" = "$3" ] || exit 0
herdr-app ls 2>/dev/null | grep -qF "\"terminal\": \"$4\"" && exit 0
herdr-app do terminal.kill "{\"terminal\":\"$4\"}" >/dev/null 2>&1
rm -f "$2"
