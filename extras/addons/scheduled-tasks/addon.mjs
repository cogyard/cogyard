// ~/.cogyard/addons/scheduled-tasks/addon.mjs — the one switch for "cogyard may
// run jobs overnight", and the setup that switch needs.
//
// THE SHAPE, in the owner's words: an add-on is ONE thing — scheduled tasks.
// Turning it on requires the agent credential, so the credential lives inside
// THIS dialog with the explanation of why it is needed. When it is on, the
// Scheduled tasks section appears, and that section lists doc-drift and whatever
// else is installed later.
//
// Before this, every scheduled job was its own add-on row carrying its own
// SCHEDULED / PREREQ MISSING / ENABLED badges and its own switch, plus a
// separate row for the credential — five controls for what is really one
// decision ("should cogyard do work while I sleep?"), and no indication that the
// credential and the jobs had anything to do with each other.
//
// This add-on runs nothing itself. It declares no schedule and no runScheduled.
// It is the capability gate and the place its prerequisite gets set up; the jobs
// stay in their own add-ons, where their code and their bounds belong.
//
// It never touches the credential's value: it asks core whether the variable
// resolves — a boolean — and supplies the WORDS for the walkthrough the dialog
// renders. Every machine-specific string comes from the context core hands in,
// so nothing here is hardcoded to one agent or one machine.

// Restarting cogyard, as TWO SEPARATE STEPS.
//
// These were once a single line — `bootout && bootstrap` — and that is a race:
// bootout returns before launchd has finished tearing the service down,
// bootstrap then fails with "Input/output error: 5", and the service is left
// UNLOADED. The portal stays dead until someone runs bootstrap again by hand.
// That happened to the owner, from this very instruction.
//
// They are two steps now, with their own Copy buttons and a step between them
// that tells you to wait for the first to finish, so the two cannot be pasted
// as one line. `kickstart -k` would do both at once, but it FAILS when the
// service is not currently loaded — which is exactly the state a botched
// restart leaves you in, so it is the wrong thing to hand someone recovering.
const STOP = 'launchctl bootout gui/$(id -u)/com.cogyard.serve';
const START = 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cogyard.serve.plist';

export const manifest = {
  id: 'scheduled-tasks',
  label: 'Scheduled tasks with LLM analysis',
  description: 'Lets cogyard run jobs for you overnight — checking your docs for drift, writing a project brief. Switch this on and the Scheduled tasks section appears below with whatever jobs you have installed.',
  icon: '🌙',
  thirdParty: false,

  // This is the flag core gates the scheduled-jobs surface on. An add-on
  // declares what it PROVIDES; core never looks for this add-on by name.
  provides: 'scheduled-jobs',

  status(_cfg, { agentCredential } = {}) {
    if (!agentCredential) {
      return { enabled: false, healthy: null, summary: 'no agent driver active — jobs would have nothing to ask' };
    }
    return {
      enabled: !!agentCredential.set,
      healthy: agentCredential.set ? true : null, // not set yet is a to-do, not a fault
      summary: agentCredential.set
        ? 'ready — jobs can run and sign in on their own'
        : 'needs an agent credential before any job can run',
      details: { variable: agentCredential.env, credentialSet: !!agentCredential.set },
    };
  },

  prereqs(_cfg, { agentCredential } = {}) {
    if (!agentCredential) {
      return [{
        id: 'driver',
        label: 'An agent driver is active',
        ok: false,
        fixHint: 'No driver is active, so there is no agent for a job to ask. See docs/DRIVERS.md.',
      }];
    }
    return [{
      id: 'credential',
      label: `${agentCredential.label} (${agentCredential.env})`,
      ok: !!agentCredential.set,
    }];
  },

  // The walkthrough. Returns null once the credential resolves, so a finished
  // setup stops showing its own instructions.
  setup(_cfg, { agentCredential, addSecretCommand, secretsPath, secretsStatus } = {}) {
    if (!agentCredential || agentCredential.set) return null;

    return {
      intro: [
        'A scheduled task runs while nobody is at the keyboard — at 5am, on its own. The work itself is done by an AI agent, and an agent has to sign in before it can do anything. There is no one there to type a password at 5am, so it signs in with a token instead.',
        `That token is ${agentCredential.env}. cogyard reads it from one file on this machine and hands it to the agent when a job starts. Until it is set, every scheduled task will fail at its slot — which is why this switch needs it.`,
        'cogyard never sees, stores, or sends the token — it only asks the operating system whether that variable is set.',
      ],
      steps: [
        {
          what: 'Get a token.',
          why: 'Run this in a terminal. It prints a value — copy it.',
          command: agentCredential.howTo || undefined,
        },
        {
          what: 'Paste the token here.',
          why: 'This builds the exact line to run — nothing is sent anywhere. Then copy it and run it in the same terminal. The second half locks the file so only you can read it; cogyard refuses to load it otherwise.',
          input: { label: 'Token from step 1', placeholder: 'paste it here' },
          command: addSecretCommand(agentCredential.env),
        },
        {
          what: 'Stop cogyard.',
          why: 'The token is only read when cogyard starts, so nothing changes until it restarts. '
            + 'If you started cogyard in a terminal, stop it there with Ctrl-C and skip to step 5. '
            + 'If it runs in the background as a macOS service, run this:',
          command: STOP,
        },
        {
          what: 'Start it again.',
          why: 'Run this on its own, AFTER the previous command has finished and returned you to the prompt. '
            + 'Do not join the two with && — stopping returns before the service has finished shutting down, and starting too early fails with '
            + '"Input/output error", leaving cogyard stopped. If that happens, just run this command again.',
          command: START,
        },
        {
          what: 'Check it worked.',
          why: 'Press Recheck at the bottom of this dialog. The check at the top — the line with the ✗ — should turn into a green ✓, and these steps disappear. '
            + `If it stays red, open ${secretsPath} and confirm it has a line starting with ${agentCredential.env}=`,
        },
      ],
      warning: secretsStatus && !secretsStatus.ok ? `That file exists but cogyard is refusing to read it: ${secretsStatus.error}` : undefined,
      warningCommand: secretsStatus && !secretsStatus.ok ? secretsStatus.fix : undefined,
    };
  },
};
