import { SecurityContext } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked } from 'marked';

// Markdown → HTML that is safe to put in the page (task 263).
//
// EVERY view that shows rendered markdown must go through this. `marked` does
// not clean HTML, and markdown may hold raw HTML: a README, a task body, a
// pasted chat turn or a nightly brief containing `<img src=x onerror=…>` or
// `<a href="javascript:…">` would otherwise run script inside the portal, with
// its full rights over /api. Binding `marked.parse(…)` through
// `bypassSecurityTrustHtml` skips Angular's cleaning, which is exactly that
// hole — so never do it; call `renderMarkdown` instead.
//
// Cleaning is Angular's own HTML sanitizer (no extra dependency). It keeps what
// marked produces — headings, lists, tables (incl. `align`), code blocks with
// their `class`, links, images, `<details>` — and drops scripts, `on…`
// attributes, `javascript:` URLs, `<iframe>`/`<object>`/`<embed>`/`<form>`/
// `<style>` and `style`/`id` attributes.
//
// One thing it also drops that the views need: `<input>`, which is how marked
// draws a GFM task-list box (`- [ ]` / `- [x]`, all over task bodies). So
// marked's boxes are emitted as a marker span the sanitizer keeps, and only
// that exact marker is turned back into marked's own disabled checkbox AFTER
// cleaning. A marker typed by hand in raw HTML just becomes a disabled box too.

const BOX = 'md-taskbox';
const BOX_ON = 'md-taskbox-on';

const md = new Marked({
  renderer: {
    checkbox({ checked }) {
      return `<span class="${checked ? `${BOX} ${BOX_ON}` : BOX}"></span> `;
    },
  },
});

const MARKER = new RegExp(`<span class="${BOX}( ${BOX_ON})?"></span>`, 'g');

/**
 * Where a markdown FILE lives, so its relative images load from beside it.
 * Rendered markdown sits inside the portal's page, so `<img src="logo.svg">`
 * would otherwise be asked of the portal's own address (a 404 — README's logo
 * did exactly that). `file` is the file's path in its worktree; `url` turns a
 * path in the same worktree into an address that serves it (the Files tab
 * passes task 262's raw route).
 */
export interface MarkdownFile {
  file: string;
  url: (path: string) => string;
}

/**
 * A relative image address resolved against the markdown file's folder, as a
 * worktree path — or null to leave it alone: anything with a scheme (`https:`,
 * `data:`, Angular's `unsafe:`), an absolute or protocol-relative `/…`, a bare
 * `#…`, or a path that climbs out of the worktree.
 */
export function resolveRelative(file: string, src: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return null;
  const parts = file.split('/').slice(0, -1);
  for (const raw of src.split(/[?#]/)[0].split('/')) {
    let seg = raw;
    try { seg = decodeURIComponent(raw); } catch { /* keep as written */ }
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Markdown → cleaned HTML string (exported for tests). */
export function markdownToSafeString(san: DomSanitizer, text: string, from?: MarkdownFile): string {
  const raw = md.parse(text ?? '', { async: false }) as string;
  const clean = san.sanitize(SecurityContext.HTML, raw) ?? '';
  const html = clean.replace(MARKER, (_m, on) => (on ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">'));
  if (!from || !/<img\b/i.test(html)) return html;
  // After cleaning, so the only addresses changed are ones the sanitizer kept,
  // and each is replaced by an address `from.url` built itself.
  const t = document.createElement('template');
  t.innerHTML = html;
  let changed = false;
  for (const img of Array.from(t.content.querySelectorAll('img[src]'))) {
    const path = resolveRelative(from.file, img.getAttribute('src') ?? '');
    if (path) { img.setAttribute('src', from.url(path)); changed = true; }
  }
  return changed ? t.innerHTML : html;
}

// Same text → same SafeHtml instance. The task body and transcript views call
// this from their templates on every change-detection pass; without the cache
// each pass would re-parse and re-clean (and, in dev mode, re-log Angular's
// "sanitizing HTML stripped some content" warning), and a new instance makes
// Angular rewrite the innerHTML each time. Bounded so a long session can't grow it.
const CACHE_MAX = 500;
const cache = new Map<string, SafeHtml>();

/**
 * Markdown → HTML for an `[innerHTML]` binding, cleaned by `markdownToSafeString`.
 * Pass `from` for a markdown file (Files tab) so its relative images load.
 */
export function renderMarkdown(san: DomSanitizer, text: string, from?: MarkdownFile): SafeHtml {
  const body = text ?? '';
  // The file's own address names the key, project, worktree and file, so the
  // same text in two files caches apart.
  const key = from ? `${from.url(from.file)}\0${body}` : body;
  const hit = cache.get(key);
  if (hit) return hit;
  const html = san.bypassSecurityTrustHtml(markdownToSafeString(san, body, from));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
