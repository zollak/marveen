# Runbook: Telegram bot(s) silent / not responding

Use this when Marveen and/or the sub-agents (admin, albi, moni) stop
responding on Telegram. Goal: from symptom to fix in under 5 minutes, not an hour.

**Trigger phrase for Zoltán:** *"néma a Telegram bot, nézd meg a
docs/local/telegram-silent-recovery.md runbookot"* — that points straight here.

---

## STEP 0 — rule out Zoltán's own Telegram client first (10 seconds)

Before running anything below, check whether the send actually failed on **our** side.

**If the `reply` tool returned `sent (id: NNNN)`, our side did its job.** A message that
"never arrived" after a successful send is, first and foremost, a *client* problem —
the Telegram desktop/mobile app on Zoltán's MBP or phone silently stalling until it is
updated and restarted.

*2026-08-24:* Zoltán asked "elhalt a folyamat?" nine minutes after a reply that had been
sent successfully. Root cause: his MBP Telegram app needed an update + restart; once
restarted, **every** queued message arrived at once. Nothing was wrong with the bot, the
MCP, the plugin, or the bridge. Running this runbook would have restarted healthy
sessions for nothing.

**Only proceed to the triage below if at least one of these holds:**
- multiple messages are lost, not one;
- the `reply` tool itself returns an error (not `sent`);
- more than one agent is silent at the same time;
- inbound messages from Zoltán stop arriving too (not just outbound).

Otherwise: ask him to restart his Telegram client, and re-check.

---

## 60-second triage

Run from `~/marveen`:

```bash
# 1. Are the bridges healthy? (HEALTHY = bun poller + live bot.pid under the pane)
bash scripts/verify-channels-health.sh

# 2. Per-bot liveness (main + each agent)
for f in "$HOME/.claude/channels/telegram/bot.pid" agents/*/.claude/channels/telegram/bot.pid; do
  [ -f "$f" ] && { p=$(cat "$f"); kill -0 "$p" 2>/dev/null && echo "OK  $f ($p)" || echo "DEAD $f"; } || echo "MISSING $f"
done

# 3. Is the telegram MCP actually LOADED in the channels session?
#    (open /mcp in the marveen-channels tmux pane; healthy = "plugin:telegram:telegram connected")
tmux send-keys -t marveen-channels Escape \; send-keys -t marveen-channels "/mcp" Enter
sleep 3; tmux capture-pane -t marveen-channels -p | grep -i telegram
tmux send-keys -t marveen-channels Escape
```

Then classify with the decision tree below.

---

## Decision tree (most common first)

### A. `/mcp` does NOT list `plugin:telegram:telegram` → plugin not resolving (THE 2026-06-22 bug)

This is the nasty one. The `--channels` banner shows, but the plugin's MCP server
never starts, so there is no poller and no `bot.pid`. Root cause: the plugin install
in `~/.claude/plugins/installed_plugins.json` is bound to the wrong project path
(e.g. only `/Users/edgar/marveen/agents/heartbeat-worker`), so it cannot be resolved
for `/Users/edgar/marveen`. Usually triggered by a **Claude Code CLI auto-update**
re-resolving plugins — NOT by a marveen-repo restart/rebase/pull.

Confirm:
```bash
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); [print(s.get('scope'), s.get('projectPath','(user-global)')) for s in d['plugins'].get('telegram@claude-plugins-official',[])]"
```
If you see only a `project <某agent-path>` line and no `user (user-global)` line → this is it.

**Fix (one command — also un-breaks every agent at once, because it's user-global):**
```bash
/Users/edgar/.local/bin/claude plugin install telegram@claude-plugins-official --scope user
```
Then restart the sessions so a FRESH claude process re-resolves the plugin (a running
process does not pick up a newly installed plugin):
```bash
# main:
launchctl kickstart -k "gui/$(id -u)/com.marveen.channels"
# each stale agent (watchdog.sh recreates it fresh on its next pass, or do it now):
for a in admin albi emil moni samu; do tmux kill-session -t "agent-$a" 2>/dev/null; done
# wait ~60s, then re-run the 60-second triage. Expect 6 live bot.pids.
```

### B. Many competing `--channels` claude processes (respawn storm) → bridges fight over getUpdates (409)

Symptom: `pgrep -af -- '--channels plugin:' | grep -v 'tmux new-session'` shows several
claude processes (different models) under the `marveen-channels` session. The dashboard
recovery ladder is storming. Each extra poller 409-conflicts the others → all silent.

Fix: stop the storm at the source (the dashboard monitor), clear orphans, bring up ONE:
```bash
bash scripts/stop.sh           # unloads dashboard + channels, kills marveen-channels tmux
# force-kill leftover MAIN channels claudes (NEVER the shared tmux server — see warning)
for pid in $(pgrep -af -- '--channels plugin:' | grep -viE 'agents/[a-z]+/|tmux new-session' | awk '{print $1}'); do kill -9 "$pid"; done
bash scripts/start.sh          # one clean dashboard + channels
```

### C. Bridge present but deaf (keepalive stale) → known "deafness", let the watchdog respawn

`verify-channels-health.sh` is HEALTHY-ish but no inbound arrives, and
`store/.channel-keepalive` is >15 min old. Normally the dashboard channel-monitor or
`channel-watchdog.sh` respawns the pane. If it doesn't, respawn manually — see
`scripts/channel-watchdog.sh` (the `respawn-pane -k` command).

### D. Telegram API itself

```bash
TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '\"'\''')"
curl -s "https://api.telegram.org/bot${TOKEN}/getMe"            # bot alive?
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"   # a set webhook URL blocks getUpdates; pending_update_count>0 = nobody polling
```
If a webhook URL is set, `deleteWebhook` clears it. Do NOT spam `getUpdates` yourself —
it steals updates from the real poller.

---

## ⚠️ Cleanup warning (do not repeat the 2026-06-22 collateral)

When killing channels processes, the `tmux new-session ... -s marveen-channels` PID is the
**shared tmux server** that also hosts every `agent-*` session. Killing it takes down all
agents. Always exclude it (`grep -v 'tmux new-session'`) and target real `claude` binaries only.

---

## Will it recur after a restart / rebase / GitHub pull?

- **marveen repo restart, `git rebase`, GitHub update, plain reboot → NO.** The plugin
  install registry lives in `~/.claude/plugins/` (outside this repo) and the user-scope
  fix survives reboots. None of these touch it.
- **Claude Code CLI auto-update → possibly.** A CLI version bump can re-resolve plugins
  and re-break the install path (this is what happened on 2026-06-22, 2.1.181→2.1.185).
  The user-scope install is more robust against it, but if a bot ever goes silent right
  after a `claude` version bump, jump straight to case **A**.
