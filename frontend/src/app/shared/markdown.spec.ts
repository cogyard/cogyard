import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { marked } from 'marked';
import { markdownToSafeString } from './markdown';

// Task 263: rendered markdown is cleaned before it reaches the page.
describe('markdownToSafeString', () => {
  let render: (md: string) => string;
  beforeEach(() => {
    const san = TestBed.inject(DomSanitizer);
    render = (md) => markdownToSafeString(san, md);
  });

  // The same HTML as the browser reads it: Angular writes a newline as `&#10;`,
  // which parses to the same text, so compare parsed markup, not raw strings.
  const dom = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.innerHTML;
  };

  const harmless = (html: string) => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    // Angular rewrites a script URL to `unsafe:javascript:…`, which a browser won't run.
    expect(html).not.toMatch(/(href|src)="\s*javascript:/i);
    expect(html).not.toMatch(/<(iframe|object|embed|form|style)\b/i);
  };

  it('drops the onerror attribute from an image', () => {
    const out = render(`<img src=x onerror="document.title='XSS-img'">`);
    harmless(out);
    expect(out).toContain('<img src="x">');
  });

  it('defuses a javascript: link but keeps its text', () => {
    const out = render(`<a href="javascript:document.title='XSS-link'">click</a>`);
    harmless(out);
    expect(out).toContain('>click</a>');
  });

  it('removes script tags and their content', () => {
    const out = render(`<script>document.title='XSS-script'</script>`);
    harmless(out);
    expect(out).not.toContain('XSS-script');
  });

  it('removes iframes, objects, embeds and forms', () => {
    harmless(render(`<iframe src="/api/health"></iframe>\n\n<object data="x"></object><embed src="x"><form action="/api/file"><button>go</button></form>`));
  });

  it('a markdown link to javascript: is not clickable either', () => {
    harmless(render(`[x](javascript:alert(1))`));
  });

  it('keeps ordinary markdown exactly as marked renders it', () => {
    const src = [
      '# Heading', '',
      '| a | b:|', '|---|--:|', '| 1 | 2 |', '',
      '```js', 'const x = 1 < 2;', '```', '',
      '[a link](https://example.com "t")', '',
      '![an image](/favicon.ico)', '',
      '1. one', '2. two', '',
      '> quote with `code` and **bold**', '',
      '<details><summary>More</summary>Hidden</details>',
    ].join('\n');
    expect(dom(render(src))).toBe(dom(marked.parse(src) as string));
  });

  it('keeps task-list checkboxes, ticked and not, as marked draws them', () => {
    const src = '- [ ] open\n- [x] done\n- plain';
    expect(dom(render(src))).toBe(dom(marked.parse(src) as string));
    expect(render(src)).toContain('<input disabled="" type="checkbox"> open');
    expect(render(src)).toContain('<input checked="" disabled="" type="checkbox"> done');
  });

  it('a raw <input> typed in the markdown is still removed', () => {
    expect(render('<input type="text" value="x">')).not.toContain('<input');
  });

  it('handles empty input', () => {
    expect(render('')).toBe('');
  });

  describe('a markdown file’s relative images', () => {
    const from = { file: 'docs/guide/README.md', url: (p: string) => `/api/raw/K/proj/wt/${p}` };
    const withFile = (md: string) => markdownToSafeString(TestBed.inject(DomSanitizer), md, from);

    it('load from beside the file, raw HTML and markdown alike', () => {
      expect(withFile('<img src="logo.svg" alt="x">')).toContain('src="/api/raw/K/proj/wt/docs/guide/logo.svg"');
      expect(withFile('![x](../img/a.png)')).toContain('src="/api/raw/K/proj/wt/docs/img/a.png"');
      expect(withFile('![x](./a%20b.png?x=1)')).toContain('src="/api/raw/K/proj/wt/docs/guide/a b.png"');
    });

    it('leave absolute, other-site, data: and out-of-worktree addresses alone', () => {
      for (const src of ['/favicon.ico', '//cdn.example/a.png', 'https://example.com/a.png', 'data:image/png;base64,AA==', '../../../up.png']) {
        expect(withFile(`<img src="${src}">`)).toContain(`src="${src}"`);
      }
    });

    it('change nothing else, and nothing without a file', () => {
      const src = '# T\n\n- [ ] box\n\n![x](a.png)';
      expect(dom(withFile(src))).toBe(dom((marked.parse(src) as string).replace('src="a.png"', 'src="/api/raw/K/proj/wt/docs/guide/a.png"')));
      expect(render('![x](a.png)')).toContain('src="a.png"');
    });

    it('a rewritten image still can’t run script', () => {
      harmless(withFile(`<img src="logo.svg" onerror="alert(1)">`));
    });
  });
});
