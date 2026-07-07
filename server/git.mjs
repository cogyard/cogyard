// server/git.mjs — portal-only read views over git (distinct from core/'s data
// layer: these shapes exist for the portal UI, not for the CLI). All read-only.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as core from '../core/index.mjs';

const SEP = '\x1f';

// The origin remote as a browsable https URL (for the portal's "open on GitHub"
// link). Normalises scp-style (git@host:owner/repo.git) and ssh:// forms to
// https://host/owner/repo, dropping the trailing .git. Returns null when there
// is no origin or it isn't a recognisable host URL.
export async function originHttpUrl(repo) {
  const raw = (await core.gitP(['config', '--get', 'remote.origin.url'], repo) || '').trim();
  if (!raw) return null;
  let url = raw;
  const scp = raw.match(/^[^@]+@([^:]+):(.+)$/); // git@github.com:owner/repo.git
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  else url = raw.replace(/^ssh:\/\/[^@]+@/, 'https://').replace(/^git:\/\//, 'https://');
  url = url.replace(/\.git$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

// Full branch inventory (local + remote) with last-commit, ahead/behind vs main,
// merged-into-main, unpushed, has-worktree and stale-age flags. Distinct from the
// Worktrees view (which only covers checked-out branches).
export async function gitBranches(repo) {
  // The branch inventory is a function of the ref OIDs (drives last-commit,
  // ahead/behind, merged, HEAD marker) plus which branches have a worktree
  // checked out (the hasWorktree flag, which can change without a ref moving).
  // Both go in the signal, so a poll with no ref/worktree change reuses the
  // cached result instead of re-running a `rev-list --count` per branch.
  return core.memoize('branches', repo,
    async () => {
      const [refs, wts] = await Promise.all([
        core.gitP(['rev-parse', '--branches', '--remotes'], repo),
        core.gitP(['worktree', 'list', '--porcelain'], repo),
      ]);
      return refs == null ? null : (refs || '') + '\x1e' + (wts || '');
    },
    () => computeBranches(repo));
}

async function computeBranches(repo) {
  const FMT = ['%(refname:short)', '%(objectname:short)', '%(committerdate:iso8601)', '%(committerdate:unix)',
    '%(committerdate:relative)', '%(authorname)', '%(contents:subject)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)'].join(SEP);
  const mainName = await core.defaultBranch(repo);
  const [refsRaw, mergedRaw, wtRaw, remotesRaw, originUrl] = await Promise.all([
    core.gitP(['for-each-ref', '--sort=-committerdate', 'refs/heads', 'refs/remotes/origin', '--format=' + FMT], repo),
    mainName ? core.gitP(['for-each-ref', '--merged', mainName, 'refs/heads', 'refs/remotes/origin', '--format=%(refname:short)'], repo) : Promise.resolve(''),
    core.gitP(['worktree', 'list', '--porcelain'], repo),
    core.gitP(['remote'], repo),
    originHttpUrl(repo),
  ]);
  const hasOrigin = (remotesRaw || '').split('\n').includes('origin');
  const merged = new Set((mergedRaw || '').split('\n').filter(Boolean));
  const wtBranches = new Map(); // branch name -> worktree dir name
  let curWtPath = null;
  for (const line of (wtRaw || '').split('\n')) {
    if (line.startsWith('worktree ')) { curWtPath = line.slice('worktree '.length); continue; }
    const m = line.match(/^branch refs\/heads\/(.+)$/);
    if (m && curWtPath) wtBranches.set(m[1], basename(curWtPath));
  }
  const nowS = Date.now() / 1000;
  // Branch → task association is a domain fact: compute it here (via the core
  // matcher) and serve `taskId`, so the SPA consumes it instead of re-deriving
  // the tag/prefix/slug rules client-side.
  const tasks = core.loadTasks(join(repo, '_tasks'));

  const rows = (refsRaw || '').split('\n').filter(Boolean).map((line) => {
    const [name, hash, iso, unix, rel, author, subject, upstream, track, head] = line.split(SEP);
    return { name, hash, iso, unix, rel, author, subject, upstream, track, head };
  }).filter((r) => r.name && r.name !== 'origin/HEAD');
  // Names that exist on the remote — a local branch "has an origin" if origin/<name> exists.
  const remoteNames = new Set(rows.filter((r) => r.name.startsWith('origin/')).map((r) => r.name.slice('origin/'.length)));

  const branches = await Promise.all(rows.map(async (r) => {
    const isRemote = r.name.startsWith('origin/');
    let aheadMain = 0, behindMain = 0;
    if (mainName && r.name !== mainName) {
      const lr = await core.gitP(['rev-list', '--left-right', '--count', `${mainName}...${r.name}`], repo);
      if (lr) { const [b, a] = lr.split(/\s+/); behindMain = +b || 0; aheadMain = +a || 0; }
    }
    let unpushed = false;
    if (!isRemote && hasOrigin) unpushed = !r.upstream || /ahead/.test(r.track || '');
    return {
      name: r.name, isRemote, hash: r.hash, author: r.author, subject: r.subject,
      iso: r.iso, relDate: r.rel, staleDays: r.unix ? Math.floor((nowS - +r.unix) / 86400) : null,
      aheadMain, behindMain, merged: merged.has(r.name), unpushed,
      hasWorktree: wtBranches.has(r.name), worktreeName: wtBranches.get(r.name) || null,
      isHead: r.head === '*', upstream: r.upstream || null,
      onOrigin: isRemote ? true : remoteNames.has(r.name),
      taskId: core.matchBranchTask(r.name, r.subject, mainName, tasks),
    };
  }));
  return { main: mainName, originUrl, branches };
}

// Working-tree status (porcelain v1, NUL-separated) → staged / unstaged /
// untracked groups. A file can appear in both staged and unstaged (e.g. "MM").
export async function gitStatus(repo) {
  const branch = (await core.gitP(['rev-parse', '--abbrev-ref', 'HEAD'], repo)) || '';
  // Raw (untrimmed) output: porcelain's leading status column is significant, and
  // core.gitP trims it away — which would corrupt the first entry's X/Y flags.
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repo, maxBuffer: 1 << 24 }).toString(); } catch { out = ''; }
  const staged = [], unstaged = [], untracked = [];
  if (out) {
    const toks = out.split('\0');
    for (let i = 0; i < toks.length; i++) {
      const e = toks[i];
      if (!e) continue;
      if (e.startsWith('??')) { untracked.push({ path: e.slice(3) }); continue; }
      const X = e[0], Y = e[1], p = e.slice(3);
      let oldPath;
      if (X === 'R' || X === 'C') { oldPath = toks[i + 1]; i++; } // rename/copy: old path follows
      if (X !== ' ' && X !== '?') staged.push({ path: p, status: X, oldPath });
      if (Y !== ' ' && Y !== '?') unstaged.push({ path: p, status: Y });
    }
  }
  return { branch, staged, unstaged, untracked, clean: !staged.length && !unstaged.length && !untracked.length };
}

// Per-file working-tree diff. Staged = `git diff --cached`, unstaged = `git diff`.
// Untracked has no git diff (gitP swallows --no-index's exit 1), so synthesize an
// all-added patch from the file content (flag binary).
export async function workDiff(repo, p, kind, ignoreWs) {
  if (kind === 'untracked') {
    const fp = join(repo, p);
    if (!existsSync(fp)) return '';
    const buf = readFileSync(fp);
    if (buf.includes(0)) return `Binary files /dev/null and b/${p} differ`;
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
  }
  const args = ['diff', '--no-color'];
  if (kind === 'staged') args.push('--cached');
  if (ignoreWs) args.push('-w');
  args.push('--', p);
  return (await core.gitP(args, repo)) || '';
}

// Commit detail (message + changed files).
// A stash commit is a merge commit (parents: base, index, and — with -u —
// untracked), so `git show --name-status` returns the empty combined-merge diff.
// Resolve it like `git stash show`: diff its base (first parent) against it.
export async function isStashCommit(repo, h) {
  const stashes = await core.listStashes(repo);
  return stashes.some((s) => s.sha === h || s.sha.startsWith(h) || h.startsWith(s.sha));
}

// A `stash -u` stores the untracked files in a THIRD parent — a parentless root
// commit whose tree is just those files. `git diff base..stash` (and plain
// `git show`) only carry the tracked modifications, so the untracked files are
// invisible; only `git stash show --include-untracked` surfaces them. Return the
// untracked-parent ref (`<h>^3`) when the stash has one, else null.
async function stashUntrackedRef(repo, h) {
  const line = await core.gitP(['rev-list', '--parents', '-n', '1', h], repo);
  const parents = (line || '').trim().split(/\s+/).slice(1);
  return parents.length >= 3 ? h + '^3' : null;
}

// Per-file diff for a stash: untracked files (present in the ^3 tree) render as a
// full add from that tree; everything else is base (first parent) → stash.
export async function stashFileDiff(repo, h, f, w) {
  const uref = await stashUntrackedRef(repo, h);
  if (uref && (await core.gitP(['cat-file', '-e', uref + ':' + f], repo)) !== null) {
    const args = ['show', '--format=', '--no-color'];
    if (w) args.push('-w');
    args.push(uref, '--', f);
    return await core.gitP(args, repo);
  }
  const args = ['diff', '--no-color'];
  if (w) args.push('-w');
  args.push(h + '^1', h, '--', f);
  return await core.gitP(args, repo);
}

export async function commitDetail(repo, h) {
  const stash = await isStashCommit(repo, h);
  const meta = await core.gitP(['show', '-s', '--date=format:%Y-%m-%d %H:%M', '--format=%H' + SEP + '%an' + SEP + '%ad' + SEP + '%s' + SEP + '%b', h], repo);
  let filesRaw;
  if (stash) {
    // tracked stashed changes (base → stash) + untracked files from the ^3 tree
    const tracked = await core.gitP(['diff', '--name-status', '--no-color', h + '^1', h], repo);
    const uref = await stashUntrackedRef(repo, h);
    const untracked = uref ? await core.gitP(['show', '--name-status', '--format=', '--no-color', uref], repo) : null;
    filesRaw = [tracked, untracked].filter(Boolean).join('\n');
  } else {
    filesRaw = await core.gitP(['show', '--name-status', '--format=', '--no-color', h], repo);
  }
  const [hash, author, date, subject, body] = (meta || '').split(SEP);
  const files = (filesRaw || '').split('\n').filter(Boolean)
    .map((l) => { const m = l.match(/^([A-Z]\d*)\t(.+)$/); return m ? { status: m[1], path: m[2] } : null; })
    .filter(Boolean);
  return { hash, author, date, subject, body: body || '', files };
}
