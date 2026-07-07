// routes/files.mjs — Files-tab endpoints: worktree pills (last activity), file
// tree with status-vs-main, file content (text JSON / raw images), diff vs main,
// and the one write: POST /api/file (the edit → save), gated by the
// http.mjs seam (origin + containment) with a baseHash concurrency check.

import { json, errJson, badRelPath, parseGuarded } from '../http.mjs';
import { findWorktree, worktreeActivity, fileTree, readWorkFile, writeWorkFile, vsMainDiff } from '../files.mjs';

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

// POST /api/file — save an edited buffer back to disk. Body:
// { p, wt, path, content, baseHash }. Same param guards as the GET, then
// writeWorkFile does containment + hash check + atomic write.
export async function handlePost(path, req, res, projects) {
  if (path !== '/api/file') return false;

  const body = await parseGuarded(req, res);
  if (!body) return true;

  const proj = body.p ? projects.find((x) => x.slug === body.p) : projects[0];
  if (!proj) { errJson(res, 404, 'unknown project: ' + body.p); return true; }
  const wtName = typeof body.wt === 'string' ? body.wt : '';
  const badWt = badWtName(wtName);
  if (badWt) { errJson(res, 400, badWt); return true; }
  const wt = findWorktree(proj, wtName);
  if (!wt) { errJson(res, 404, 'unknown worktree: ' + wtName); return true; }
  const badPath = badRelPath(body.path || '');
  if (badPath) { errJson(res, 400, badPath); return true; }
  if (typeof body.content !== 'string' || typeof body.baseHash !== 'string') {
    errJson(res, 400, 'content and baseHash required'); return true;
  }

  const r = await writeWorkFile(wt.path, body.path, body.content, body.baseHash);
  if (r.forbidden) { errJson(res, 403, 'forbidden'); return true; }
  if (r.missing) { errJson(res, 404, 'no such file in worktree'); return true; }
  if (r.notText) { errJson(res, 400, 'not an editable text file'); return true; }
  if (r.tooLarge) { errJson(res, 413, 'file exceeds the 1 MB edit cap'); return true; }
  if (r.conflict) { json(res, 409, { error: 'file changed on disk', currentHash: r.conflict.currentHash }); return true; }
  json(res, 200, r.ok);
  return true;
}
