// render.mjs — turning a run's outcome into the markdown a human reads.
//
// Two shapes, and the difference between them is the point:
//   * a WRITTEN brief — the agent's three paragraphs, optional detail, a cost footer;
//   * a FAILED brief — no paragraphs at all, an unmistakable block saying the run
//     could not look, why, and what to do about it.
//
// "Nothing happened" and "I could not look" must never render the same way. A
// brief's failure mode is ABSENCE, and absence is exactly what a person does not
// notice: the realistic bad outcome is a token dying in November and the owner
// noticing in January, having spent two months reading an empty page as a quiet
// one. So a failure occupies the same space a brief would have, in alarm colours,
// and says more each night it repeats.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp));
  if (!m) return String(stamp);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function money(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

// The escalation ladder. One bad night is a blip; three is a dead credential
// nobody has noticed. Repeating the same sentence every night is how a warning
// becomes wallpaper, so each rung says something the previous one didn't.
function escalation(nights, kind) {
  // An unusable answer is not a dead credential: the agent ran, was paid, and
  // replied with something that was not a brief. Saying "your credential is
  // dead" for that would send the owner to fix the one thing that is working.
  if (kind === 'unusable') {
    return nights <= 1
      ? 'The agent ran and was paid, but what came back was not a brief. Tonight it will be asked again.'
      : `**${nights} nights running.** The agent answers and is paid each time, but never with a brief — so this is the prompt or the model, not the credential. The reason above is what it did instead.`;
  }

  // A STALL is not a dead credential either, and this is the distinction the
  // whole of task 138 exists to draw. Output began — so the agent was reached,
  // authenticated, and started answering — and then stopped. Telling the owner
  // to re-mint a token here sends him to fix the one thing the evidence proves
  // is working. Before this, every one of these read as "your credential is
  // dead", five projects a night.
  if (kind === 'stalled') {
    return nights <= 1
      ? 'The agent was reached and began answering, then went quiet. The credential is fine — this call wedged. Tonight it will be asked again.'
      : `**${nights} nights running.** Each time the agent connects, starts answering, and then stops. That rules out the credential and the network; it is the call itself hanging. Compare the times recorded on these briefs — if they cluster, the prompt for this project may be too large for the model to finish.`;
  }

  // The run was shutting down. Nothing is wrong with the agent; this project
  // simply never got its turn.
  if (kind === 'cancelled') {
    return 'The nightly run ended before this project\'s call finished, so nothing was read. This says nothing about the agent — the run itself was stopped.';
  }

  if (nights <= 1) {
    return 'If tomorrow works, this was a blip. If it does not, the portal has lost its agent credential.';
  }
  if (nights === 2) {
    return '**Second night in a row.** This is no longer a blip — check the credential.';
  }
  return [
    `**${nights} nights in a row with no brief.** Assume the portal's agent credential is dead —`,
    'this project has been running unobserved for that long, and so has every other one.',
    '',
    'For the Claude driver, re-mint the token, put it in `CLAUDE_CODE_OAUTH_TOKEN` in the',
    '`com.cogyard.serve` LaunchAgent environment, and reload the agent:',
    '',
    '```bash',
    'claude setup-token',
    '```',
  ].join('\n');
}

// A run that could not produce a brief. Deliberately NOT a one-liner in a log:
// this replaces the three paragraphs in the file the owner actually opens.
//
// It says only that the night was blind, and why. It does NOT reprint the last
// brief that worked — that was here until 2026-09-03, on the theory that the
// most recent thing anyone knows is the most useful thing on the page. It is
// not: the Daily tab shows the previous nights directly underneath, so the
// reprint was the same prose twice on one screen. The date of the last good
// brief is still recorded in `last_good` for anything that wants to point at
// it; the words live in their own file, once.
// The ways a night can fail, and the words for each. They must not read alike:
// before task 138 every one of them said "aborted", so a night the model merely
// wedged was indistinguishable from a night the credential died — and the owner
// was sent to re-mint a working token five times over.
//
//   'no-response' — nothing ever arrived. The agent was never reached: a dead
//                   credential, no network, a server that is down.
//   'stalled'     — output began and then stopped. The agent WAS reached and
//                   was answering; the call wedged. The credential is fine.
//   'cancelled'   — the run itself ended first. Not the agent's doing at all.
//   'error'       — the agent could not run, or reported its own error.
//   'unusable'    — the agent replied, but not with a brief. Something WAS read
//                   and paid for; what came back could not be trusted, and
//                   writing it up anyway would have produced a page that reads
//                   as true. See parseProse in prompt.mjs.
const HEADLINE = {
  unusable: 'The agent did not write a brief',
  stalled: 'The agent stopped mid-answer',
  'no-response': 'The agent could not be reached',
  cancelled: 'The run ended before this project',
  error: 'No brief could be written',
};

const GIST = {
  unusable: ['**What came back was not a brief, so none was written.** Nothing below was',
    'judged — treat this project\'s state as unknown rather than unchanged.'],
  stalled: ['**The agent connected, began answering, and then went silent.** It was not cut',
    'off for being slow — it stopped producing. Nothing was read, so treat this',
    'project\'s state as unknown rather than unchanged.'],
  'no-response': ['**Nothing came back at all — not a word.** The agent was never reached, so',
    'treat this project\'s state as unknown rather than unchanged.'],
  cancelled: ['**The nightly run stopped before this project\'s call finished.** Nothing here',
    'was read, so treat this project\'s state as unknown rather than unchanged.'],
  error: ['**This is not a quiet night — it is a blind one.** Nothing here has been read,',
    'so treat this project\'s state as unknown rather than unchanged.'],
};

function failedBrief({ project, date, error, nights, kind = 'error' }) {
  const headline = HEADLINE[kind] || HEADLINE.error;
  const gist = (GIST[kind] || GIST.error).map((l) => `> ${l}`);
  const out = [
    `# ${project} — ${prettyDate(date)}`,
    '',
    `> ### ⚠️ ${headline}`,
    '>',
    ...gist,
    '>',
    `> **Why:** ${String(error || 'unknown error').trim()}`,
    '>',
    ...String(escalation(nights, kind)).split('\n').map((l) => (l ? `> ${l}` : '>')),
  ];
  return out.join('\n');
}

// A written brief: the agent's prose verbatim under a dated heading, then the
// optional evidence block, then what the run cost.
//
// The agent's text is NOT reformatted or re-wrapped. If the prose is bad, the
// prompt is what to fix — dressing it up here would hide that.
function writtenBrief({ project, date, prose, detail, cost, model }) {
  const out = [`# ${project} — ${prettyDate(date)}`, '', String(prose).trim()];
  if (detail && detail.trim()) {
    out.push('', '<details>', '<summary>What landed since the last brief</summary>', '', detail.trim(), '', '</details>');
  }
  out.push('', '---', '', `*Nightly brief · ${money(cost)}${model ? ` · ${model}` : ''}*`);
  return out.join('\n');
}

export { prettyDate, money, escalation, failedBrief, writtenBrief };
