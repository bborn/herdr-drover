#!/bin/zsh
# A stand-in agent for the demo: it sets a terminal title and reports one status
# to Herdr (OSC 7501), and nothing else runs.
#   usage: fake-agent.sh <state> <app> [title] [kind]
#   state: working, idle, done, blocked or error
#   app:   the agent it reports (claude-code, codex, ...)
#   kind:  for blocked, what it waits on: permission, question or auth
# "done" reports working for a few seconds first, because Herdr only shows done
# for an agent that finished while you weren't looking at it.
printf '\e]2;%s\a' "${3:-agent}"
print "Demo agent: it reports \"$1\" to Herdr and nothing else runs here."
if [[ $1 == done ]]; then printf '\e]7501;state=working:app=%s\a' "$2"; sleep 4; fi
while true; do
  printf '\e]7501;state=%s:app=%s%s\a' "$1" "$2" "${4:+:kind=$4}"
  sleep 5
done
