// routes/files.mjs — Files-tab endpoints: worktree pills (last activity), file
// tree with status-vs-main, file content (text JSON / raw images), diff vs main.
// Read-only.

import { json, errJson, badRelPath } from '../http.mjs';
import { findWorktree, worktreeActivity, fileTree, readWorkFile, vsMainDiff } from '../files.mjs';

// Worktree pill param: a directory basename, never a path. '' = main checkout.
function badWtName(w) {
  return (w === '' || /^[\w][\w.-]*$/.test(w)) ? null : 'bad worktree';
}

export async function handle(path, u, proj, res) {
  if (path === '/api/wt-activity') return json(res, 200, { slug: proj.slug, worktrees: worktreeActivity(proj) });
  if (path !== '/api/tree' && path !== '/api/file' && path !== '/api/wtdiff') return false;

  const wtName = u.searchParams.get('wt') || '';
  const badWt = badWtName(wtName);
  if (badWt) return errJson(res, 400, badWt);
  const wt = findWorktree(proj, wtName);
  if (!wt) return errJson(res, 404, 'unknown worktree: ' + wtName);

  if (path === '/api/tree') {
    const ignored = u.searchParams.get('ig') === '1';
    return json(res, 200, { worktree: wt.name, ...(await fileTree(wt.path, { ignored })) });
  }

  const f = u.searchParams.get('path') || '';
  const badPath = badRelPath(f);
  if (badPath) return errJson(res, 400, badPath);

  if (path === '/api/file') {
    const r = readWorkFile(wt.path, f);
    if (r.forbidden) return errJson(res, 403, 'forbidden');
    if (r.missing) return errJson(res, 404, 'no such file in worktree');
    if (r.image) {
      res.writeHead(200, { 'Content-Type': r.mime, 'Cache-Control': 'no-store' });
      return res.end(r.image);
    }
    return json(res, 200, r.meta);
  }
  if (path === '/api/wtdiff') {
    const patch = await vsMainDiff(wt.path, f, u.searchParams.get('w') === '1');
    return json(res, 200, { patch });
  }
  return false;
}
