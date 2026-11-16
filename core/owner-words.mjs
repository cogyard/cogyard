// core/owner-words.mjs — did the owner tell the agent to do this? (task 237)
//
// Some task commands are the owner's call (`close --enough`, `close --force`;
// task 228). The owner's rule: telling an agent to run one counts the same as
// running it. So an agent passes the owner's exact words (`--asked "…"`), and
// this checks them against what the owner actually typed in that chat — the
// driver's `transcripts.ownerTurns()`, which already leaves out anything the
// agent wrote, tool output, pasted text and other chats. Agent-agnostic: no
// transcript format here, only the words.
//
// The words must say what the command does — "close" and the word naming the
// outcome ("enough" for ENOUGH, "done" for DONE despite open boxes). A bare
// "close it" is neither (where-is-maya task 153 was closed ENOUGH on that), and
// "close it when it's done" is a plain close, not an override.

const CLOSE_RE = /\bclos(e|ed|es|ing)\b/;
const CONDITION_RE = (word) => new RegExp(`\\b(when|once|after|until|if|before)\\s+(it'?s\\s+|it\\s+is\\s+|you'?re\\s+|you\\s+are\\s+|we'?re\\s+|everything'?s\\s+|all\\s+)?${word}\\b`);

// Lower case, straight quotes, single spaces — so a quote copied with
// different spacing or typography still matches what the owner typed.
export function normalizeWords(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// quote: the owner's words as the agent passed them. word: the outcome word the
// command needs ('enough' | 'done'). turns: the owner's typed messages in this
// chat. → { ok: true } or { ok: false, reason } — the reason is one line, for
// the refusal.
export function checkOwnerWords({ quote, word, turns }) {
  const q = normalizeWords(quote);
  if (!q || quote === true) return { ok: false, reason: 'no --asked "<the owner\'s exact words>" was given' };
  if (!CLOSE_RE.test(q) || !new RegExp(`\\b${word}\\b`).test(q)) {
    return { ok: false, reason: `the quoted words must say "close" and "${word}" — "${quote}" doesn't` };
  }
  if (CONDITION_RE(word).test(q)) {
    return { ok: false, reason: `"${quote}" asks for a close once the work is ${word}, not a close as ${word.toUpperCase()}` };
  }
  if (!(turns || []).some((t) => normalizeWords(t).includes(q))) {
    return { ok: false, reason: `"${quote}" is not in any message the owner typed in this chat` };
  }
  return { ok: true };
}
