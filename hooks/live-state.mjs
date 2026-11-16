#!/usr/bin/env node
// Live-state hook (task 202): file what the agent is doing right now, so the
// Plan and Tasks tabs can show working / needs you / stopped per claimed task.
//
// Wired on the agent's every relevant event (the Claude driver's list is in
// drivers/claude/hooks/hooks.json). The ACTIVE driver's adapter turns the raw
// hook input into a neutral event (adapter.liveState.parseHook); this file only
// hands it to core/live-state.mjs. It knows no agent's input format.
//
// NEVER in the agent's way: it runs on every tool call, so it does one small
// file write, prints nothing, and exits 0 whatever happens — a missing or
// unwritable $COGYARD_HOME/live/, bad input, a broken adapter.

let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { process.exit(0); }

try {
  const input = JSON.parse(raw);
  const { adapter } = await import('../core/drivers.mjs');
  if (adapter.liveState?.supported) {
    const ev = adapter.liveState.parseHook(input);
    if (ev) {
      const { recordEvent } = await import('../core/live-state.mjs');
      recordEvent(ev, adapter.name);
    }
  }
} catch { /* fail-open: a hook that breaks must never break the chat */ }
process.exit(0);
