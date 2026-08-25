# Incident 2026-07-22 — inter-agent message replay "tsunami"

## Symptom
When Zoltán restarted the `moni` agent (~12:44), the `marveen` (main channels) session
received a burst of admin status messages from **2 days earlier** (FinDB VERIFY, 11-restore,
web-UI, PR-blocker), delivered as if fresh. Marveen acted on a stale PR-blocker and relayed
it to Zoltán, mixing 07-20 context into today's live FinDB work.

## Evidence
`agent_messages` (store/claudeclaw.db), the 5 replayed rows (admin → marveen):

| id  | created (07-20)     | delivered (07-22)   |
|-----|---------------------|---------------------|
| 589 | 15:40:29            | 12:44:36            |
| 591 | 15:48:59            | 12:46:37            |
| 593 | 16:02:39            | 12:46:58            |
| 595 | 16:24:38            | 12:48:28            |
| 596 | 16:32:42            | 12:49:53            |

- All 5 sat `pending` for ~2 days, then all delivered within ~5 min of the marveen-channels
  session being recreated (new tmux session stamped 12:44:30).
- Router host `com.marveen.dashboard` (PID 10843) has been **up continuously since 2026-07-10** —
  the router was ticking the whole time, this was NOT a dashboard crash.
- `failed` bucket has **0 rows created after 07-19** — nothing was actually deleted. Zoltán's
  "az inter-agent üzenetek törlődtek" is a perception: the messages were **stuck-pending and
  invisible** for 2 days, not row-deleted.

## Root cause
`src/web/message-router.ts` delivers pending inter-agent messages on a 5s tick. For each pending
message it resolves the target session and:
- `shouldAbandon(sessionExists, ageMs, window)` = `!sessionExists && ageMs > 1h`. **Abandon fires
  ONLY when the target session is ABSENT** for >1h. A session that EXISTS but is not
  ready-for-prompt (busy / wedged / mid-turn / awaiting a permission prompt) is **never abandoned**
  — it retries forever (deliberate: a prior fix stopped abandoning alive-but-busy sessions after
  losing two reports).
- If the session exists but `isSessionReadyForPrompt` is false, it logs "busy, will retry" and
  keeps the message pending. A janitor (`clearStaleParkedInput`) only rescues one narrow shape:
  an idle 'typing' pane with stable parked text.

What happened:
1. The **old marveen-channels Claude session wedged** at/before 07-20 15:40 — stuck in a
   not-ready-for-prompt state the janitor's narrow condition did not match.
2. The router saw marveen-channels as "exists but busy → retry" every 5s. Because the session
   **existed** (not absent), `shouldAbandon` never fired. The 5 admin→marveen messages stranded
   as `pending` indefinitely: no delivery, no abandonment, no alert.
3. At ~12:44 Zoltán's restart recreated marveen-channels as a **fresh, ready** session.
4. The next ticks flushed all 5 stranded 07-20 messages at once → the "tsunami," interleaved with
   today's live FinDB messages, with **no age marker** to distinguish old from new.

## Two design gaps
1. **Wedged-but-alive receiver strands messages forever.** Abandon triggers on session *absence*
   only; a session that exists but is never ready is a blind spot. The janitor covers one narrow
   parked-input shape, not a session wedged another way (permission prompt, error, stuck turn).
2. **No staleness cap / age annotation on delivery.** A 2-day-old message is injected verbatim,
   indistinguishable from fresh. The receiving agent cannot tell stale status from live status,
   so it acts on obsolete context.

## Fix options (NOT yet implemented — pending Zoltán's go)
- **A. Stale-drop / stale-mark on delivery.** In the router, when `ageMs` exceeds a threshold
  (e.g. > 2h), either mark the message `failed('stale')` instead of delivering, or prepend an
  explicit `[N óra régi üzenet — lehet elavult]` banner to the wrapped payload so the receiver
  weighs it correctly. Lowest-risk, directly prevents the "acted on stale" failure.
- **B. Abandon wedged-alive sessions too.** Extend the abandon condition: if a session exists but
  has been continuously not-ready for the full window, abandon (or alert) instead of retrying
  forever. Needs a per-message "not-ready since" tracker to avoid clobbering genuinely-busy turns.
- **C. Wedged-session detector + auto-recover.** A watchdog that flags a channels/agent session
  stuck not-ready for >N minutes and restarts it (like the MCP watchdog), so messages never queue
  for days in the first place.

Recommended: **A** now (cheap, kills the dangerous symptom), then **C** as the durable cure.

## Lessons — handling the fallout (added 2026-07-22, from admin + moni)

- **A receiver's verify is often *temporally correct*, not stale.** The same query returns
  different results on the two sides of an intervening mutation (e.g. a DB flip). When message
  reordering delivers a *pre-mutation* verify while the DB is already in the *post-mutation* state,
  the two verifies look contradictory — but each was correct for the DB at its own moment. This is
  a consequence of message **order**, NOT an agent error or a stale session.
  - **Concrete example (today's findb transfer-flip):** moni reported `854/855 = out` BEFORE the
    flip (they were genuinely tombstoned then) and `854/855 = in` AFTER (the flip un-tombstoned and
    kept them). Both reports were correct for the DB at that time; the apparent contradiction was
    ordering. Moni's safety-HOLDs were correct throughout and prevented transfer loss.
- **Defence:** do NOT auto-classify an apparent contradiction between two verifies as
  "stale/wrong," and above all do NOT discard a correct safety-HOLD because of it. Instead:
  (1) check the **actual** state with a fresh, full-id DB query (two-source if possible — e.g.
  postgres + the agent's own DSN); (2) reconcile the two verifies **by time**, placing each
  relative to the mutation boundary. A HOLD costs a round-trip; a wrongly-dropped HOLD can cost
  data. When a verify disagrees with your model, re-query — don't overrule the cautious agent.
