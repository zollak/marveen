#!/bin/bash
# Sub-agent REBOOT resilience (only). Runs ONCE at login/boot (RunAtLoad); NOT on
# an interval -- so if Zoltan STOPS an agent from the dashboard during runtime, it
# STAYS stopped (this script won't revive it). Runtime death-recovery is the
# dashboard's own auto-restart-runner (per-agent, dashboard-controlled). This
# script only brings the fleet UP after a reboot, once the dashboard is ready.
set -u
TMUX=/opt/homebrew/bin/tmux
DIR=/Users/edgar/marveen
LOG="$DIR/store/ensure-agents.log"
TOKEN="$(cat "$DIR/store/.dashboard-token" 2>/dev/null)"
[ -z "$TOKEN" ] && exit 0
# Wait for the dashboard HTTP to come up (up to ~3 min after a reboot).
up=0
for i in $(seq 1 18); do
  if curl -s --max-time 5 -o /dev/null "http://localhost:3420/api/auth/status" 2>/dev/null; then up=1; break; fi
  sleep 10
done
[ "$up" = "0" ] && { echo "$(date '+%F %T') dashboard not up after wait, giving up this boot" >> "$LOG"; exit 0; }
# Az agens-lista DINAMIKUS (2026-08-25). Korabban be volt drotozva a nevsor,
# amit egy agens torlesekor/letrehozasakor kezzel kellett kovetni -- ez tobbszor
# is hibaforras volt (emil/samu torlesekor a script meg probalta volna inditani
# oket). Sorrend:
#   1. store/agents-desired.json -- a dashboard SAJAT forrasa arrol, mely agensek
#      FUSSANAK. A DELETE /api/agents kezelo maga tartja karban (removeDesiredAgent),
#      es a leallitott agens is kikerul belole -- pontosan az a szemantika, amit ez
#      a script akar.
#   2. Ha az a fajl hianyzik/olvashatatlan: agents/*/ konyvtarak, KIVEVE amiben van
#      .hidden-from-dashboard sentinel (az nem felhasznaloi agens, hanem rendszer-
#      artefaktum, pl. a heartbeat-worker izolacios homokozo).
AGENTS=""
DESIRED="$DIR/store/agents-desired.json"
if [ -r "$DESIRED" ]; then
  AGENTS="$(/usr/bin/python3 -c "
import json,sys
try:
    d=json.load(open('$DESIRED'))
    print(' '.join(x for x in d if isinstance(x,str)))
except Exception:
    pass
" 2>/dev/null)"
fi
if [ -z "$AGENTS" ]; then
  for d in "$DIR"/agents/*/; do
    n="$(basename "$d")"
    [ -f "$d/.hidden-from-dashboard" ] && continue
    AGENTS="$AGENTS $n"
  done
  echo "$(date '+%F %T') agents-desired.json unusable, fell back to agents/ dirs: $AGENTS" >> "$LOG"
fi
[ -z "$AGENTS" ] && { echo "$(date '+%F %T') no agents to start" >> "$LOG"; exit 0; }
echo "$(date '+%F %T') boot fleet: $AGENTS" >> "$LOG"
for a in $AGENTS; do
  if ! "$TMUX" has-session -t "agent-$a" 2>/dev/null; then
    if curl -s --max-time 25 -X POST "http://localhost:3420/api/agents/$a/start" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1; then
      echo "$(date '+%F %T') boot-started missing agent-$a" >> "$LOG"
    else
      echo "$(date '+%F %T') FAILED to start agent-$a" >> "$LOG"
    fi
  fi
done
exit 0
