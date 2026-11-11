#!/bin/zsh
# Opens a second Herdr window with Drover and two spaces of demo agents, isolated
# from your own Herdr: its own app home and its own herdr-core session, so nothing
# here touches your spaces, terminals or settings. (The approach comes from
# shellscape/herdr-whitby's demo script.)
#
#   scripts/demo.sh          start the demo (DEMO_SIZE=1280x800 sets the window size)
#   scripts/demo.sh stop     quit it and stop its core
#
# DEMO_DIR picks where it lives (default: /tmp/herdr-drover-demo). Keep the path
# short: Herdr and herdr-core talk over unix sockets inside it.
set -euo pipefail

repo=${0:A:h:h}
dir=${DEMO_DIR:-/tmp/herdr-drover-demo}
dir=${dir%/}
demo_env=(
  HERDR_APP_HOME="$dir/app" XDG_CONFIG_HOME="$dir/cfg" XDG_STATE_HOME="$dir/st"
  XDG_RUNTIME_DIR="$dir/rt" HC_SESSION=drover-demo
  # No update downloads or telemetry from a throwaway window.
  HERDR_RELEASES_URL=http://127.0.0.1:9 HERDR_TELEMETRY=0 DO_NOT_TRACK=1
)
in_demo() { env "${demo_env[@]}" "$@"; }
core_pid() { "$@" hc server status --json 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p' | tail -1; }

if [[ ${1:-start} == stop ]]; then
  in_demo herdr-app do app.quit >/dev/null 2>&1 || true
  in_demo hc server stop >/dev/null 2>&1 || true
  rm -rf "$dir"
  print "Stopped the demo and removed $dir."
  exit 0
fi

# Install the layout, its mods and keys into the demo's home, opening on it,
# past the welcome.
mkdir -p "$dir"/{app/layouts,app/mods,cfg,st,rt,projects/web-app,projects/api}
chmod 700 "$dir/rt"
cp "$repo/layouts/drover.json" "$dir/app/layouts/"
for m in "$repo"/mods/*(/); do rm -rf "$dir/app/mods/${m:t}" && cp -R "$m" "$dir/app/mods/"; done
cp "$repo/keys.json" "$dir/app/keys.json"
print '{"layout":"drover","frame.welcomed":"finished"}' > "$dir/app/shared.json"
print "{\"last_run\":\"$(herdr-app --version | awk '{print $NF}')\",\"presented\":[]}" > "$dir/app/update-notes.json"
if [[ -n ${DEMO_SIZE:-} ]]; then
  print "{\"state\":\"windowed\",\"bounds\":[120.0,120.0,${DEMO_SIZE%x*}.0,${DEMO_SIZE#*x}.0]}" > "$dir/app/window.json"
fi

in_demo nohup herdr-app >"$dir/app.log" 2>&1 &
for _ in {1..30}; do in_demo herdr-app status >/dev/null 2>&1 && break; sleep 0.5; done

# Never fill your own core with demo agents.
mine=$(core_pid env)
theirs=$(core_pid in_demo)
if [[ -z $theirs || $theirs == "$mine" ]]; then
  print -u2 "The demo's herdr-core isn't separate from yours; not adding agents."
  exit 1
fi

fake=$repo/scripts/fake-agent.sh
web=$dir/projects/web-app
api=$dir/projects/api
json_argv() { local a=() s; for s in "$@"; do a+=("\"$s\""); done; print -r -- "[${(j:,:)a}]"; }
tab() { in_demo herdr-app do tab.new "{\"folder\":\"$1\",\"argv\":$(json_argv "$fake" "${@:2}")}" >/dev/null; }

in_demo herdr-app do space.new "{\"name\":\"web-app\",\"folder\":\"$web\",\"argv\":$(json_argv "$fake" working claude-code '✳ Fix the login redirect')}" >/dev/null
tab "$web" blocked claude-code '✳ Add rate limits to signup' permission
tab "$web" done codex 'Write tests for the cart'
tab "$web" idle claude-code '✳ Tidy the settings page'
in_demo herdr-app do space.new "{\"name\":\"api\",\"folder\":\"$api\",\"argv\":$(json_argv "$fake" working codex 'Migrate the orders table')}" >/dev/null
tab "$api" blocked claude-code '✳ Which retry policy?' question
in_demo herdr-app do space.select '{"index":1}' >/dev/null
in_demo herdr-app do tab.select '{"index":1}' >/dev/null

print "Demo running from $dir. Stop it with: scripts/demo.sh stop"
