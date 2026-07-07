// files/editor.ts — CodeMirror 6 wiring for the Files tab's edit mode.
// Loaded ONLY via dynamic import from files.component.ts, so the whole CodeMirror
// stack lands in its own lazy chunk: browsing/reading files never downloads it;
// the first Edit click does, once.

import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Compartment, type Extension } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';

// Same extension set the read view highlights (LANG_BY_EXT in files.component);
// exts with no CodeMirror package (sh, toml, ini…) edit as plain text.
const LANG_FOR_EXT: Record<string, () => Extension> = {
  ts: () => javascript({ typescript: true }), mts: () => javascript({ typescript: true }), cts: () => javascript({ typescript: true }),
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(),
  json: () => json(),
  html: () => html(),
  xml: () => xml(), svg: () => xml(), plist: () => xml(),
  css: () => css(), scss: () => css(),
  py: () => python(),
  yml: () => yaml(), yaml: () => yaml(),
  md: () => markdown(),
  sql: () => sql(),
};

// Match the read view's type scale; the pane's .body provides the scroll box.
const sizing = EditorView.theme({
  '&': { height: '100%', fontSize: '12px' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', monospace", lineHeight: '1.55' },
});

export interface EditorHandle {
  getDoc(): string;
  setDoc(doc: string): void; // replace everything (conflict reload / formatted save)
  setDark(dark: boolean): void;
  setWrap(wrap: boolean): void;
  destroy(): void;
}

export function mountEditor(host: HTMLElement, opts: {
  doc: string;
  fileExt: string;
  dark: boolean;
  wrap: boolean;
  onDocChanged: (doc: string) => void;
  onSave: () => void;
}): EditorHandle {
  const theme = new Compartment();
  const wrap = new Compartment();
  const lang = LANG_FOR_EXT[opts.fileExt];
  const view = new EditorView({
    parent: host,
    doc: opts.doc,
    extensions: [
      // Cmd+S saves; registered BEFORE basicSetup so it wins, and before
      // indentWithTab so Tab still indents.
      keymap.of([{ key: 'Mod-s', run: () => { opts.onSave(); return true; }, preventDefault: true }, indentWithTab]),
      basicSetup,
      ...(lang ? [lang()] : []),
      theme.of(opts.dark ? oneDark : []),
      wrap.of(opts.wrap ? EditorView.lineWrapping : []),
      sizing,
      EditorView.updateListener.of((u) => { if (u.docChanged) opts.onDocChanged(u.state.doc.toString()); }),
    ],
  });
  view.focus();
  return {
    getDoc: () => view.state.doc.toString(),
    setDoc: (doc) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } }),
    setDark: (dark) => view.dispatch({ effects: theme.reconfigure(dark ? oneDark : []) }),
    setWrap: (on) => view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) }),
    destroy: () => view.destroy(),
  };
}
