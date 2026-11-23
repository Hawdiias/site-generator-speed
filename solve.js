// A fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns the same output tree makefun-site's build returns for
// every input, byte for byte, but the hot paths are rebuilt for speed:
//   - HTML escaping scans a string once and returns it untouched when it
//     holds nothing to escape (the reference escapes character by character).
//   - The Markdown inline pass walks the text once, keeping plain runs
//     unescaped-checked, instead of recursing and re-scanning per character.
//   - Block classification tests first characters by hand instead of
//     running half a dozen regular expressions over every line.
//   - Slugs are memoised inside one build (tag names and headings repeat
//     constantly), link targets are memoised per source (a body links to
//     the same handful of targets again and again), and reading time is
//     counted without allocating the word list.
// Everything lives inside run(): a case is answered alone, with no state
// carried from one case to the next.

// ---------------------------------------------------------------- text

const ESC_TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped (the engine's own scan beats a JS loop). */
function esc(text) {
  return text.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

const SLUG_MAX = 64;

/** The slug of `text`, by makefun-site's rule (see its README, "Text"). */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is JavaScript whitespace (the \s class). */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

/** How many runs of non-whitespace `text` holds (its words). */
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The common whitespace (space and the ASCII controls) is checked
    // inline; only a code past ASCII can be an exotic \s, via isWsCode.
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c))) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    const parts = [];
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        parts.push(n);
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else parts.push(c);
    }
    return { value: parts.join('') };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length > 64) return { error: 'key "slug": not a slug' };
      let seg = 0;
      for (let i = 0; i <= raw.length; i++) {
        const c = i < raw.length ? raw.charCodeAt(i) : 45;
        if (c === 45) {
          if (seg === 0) return { error: 'key "slug": not a slug' };
          seg = 0;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
        else return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankFmLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let closeBody = -1;
  let pos = firstNl + 1;
  let lineNo = 1;
  while (true) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    lineNo++;
    if (line === '---') {
      closeBody = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push([lineNo, line]);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeBody === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (const [num, line] of fmLines) {
    if (isBlankFmLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${num} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    while (raw.endsWith(' ') || raw.endsWith('\t')) raw = raw.slice(0, -1);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeBody) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** Whether position `pos` is swallowed as the second half of an escape pair, scanning from `from`. */
function isEscapedAt(s, pos, from) {
  if (pos <= from || s.charCodeAt(pos - 1) !== 92) return false;
  let runStart = pos - 1;
  while (runStart > from && s.charCodeAt(runStart - 1) === 92) runStart--;
  return (pos - 1 - runStart) % 2 === 0;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let idx = s.indexOf(what, from);
  while (idx !== -1) {
    if (!isEscapedAt(s, idx, from)) return idx;
    idx = s.indexOf(what, idx + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c !== 42) { j++; continue; }
    if (s.charCodeAt(j + 1) === 42) { j += 2; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` resolves a link's href. */
function inline(s, env) {
  // The regexp jumps between the characters that can start a construct (or
  // need escaping); the plain text between two of them is copied untouched.
  // Each call owns its regexp, so the recursion below cannot disturb it.
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    const at = m === null ? n : m.index;
    if (at > i) out += s.slice(i, at);
    if (m === null) break;
    i = at;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE.has(s.charCodeAt(i + 1))) {
        const e = s[i + 1];
        out += e === '>' ? '&gt;' : e;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWs(target)) {
        out += `<a href="${esc(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i++;
      }
      continue;
    }
    out += ESC_TABLE[s[i]];
    i++;
  }
  return out;
}

function hasWs(text) {
  for (let i = 0; i < text.length; i++) if (isWsCode(text.charCodeAt(i))) return true;
  return false;
}

// ---- block classification, by hand

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimSpaceTabs(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence opening line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let j = 0;
  while (line.charCodeAt(j) === 35) j++;
  if (j < 1 || j > 6) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let k = j;
  while (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9) k++;
  let end = line.length;
  while (end > k && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end <= k) return null;
  return { depth: j, text: line.slice(k, end) };
}

function isHr(line) {
  const a = line.charCodeAt(0);
  if (!((a === 45 || a === 42) && line.charCodeAt(1) === a && line.charCodeAt(2) === a)) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's raw text, or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's { num, text }, or null. */
function orderedText(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWsCode(line.charCodeAt(j));
}

/** `src` rendered to { html, toc, excerpt }; slugify is the build's memoised one. */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      out += `<pre><code${cls}>`;
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) { out += `${esc(lines[i])}\n`; i++; }
      i++;
      out += '</code></pre>\n';
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      out += `<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out += '<hr>\n'; i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimSpaceTabs(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      out += kept.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const text = isOrdered ? orderedText(lines[i])?.text : bulletText(lines[i]);
        if (text !== undefined && text !== null) {
          items.push([trimSpaceTabs(text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimSpaceTabs(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      out += `${block}</${tag}>\n`;
      continue;
    }
    const body = [trimSpaceTabs(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) { body.push(trimSpaceTabs(lines[i])); i++; }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isBlankSpan(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankSpan(src, lineStart, open) && isBlankSpan(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---- template compilation
//
// A parsed template is compiled once per build into a plain JavaScript
// function (the interpreter above is the fallback when compilation is not
// available). Paths whose head a surrounding for-loop binds compile to
// direct variable reads; every other path goes through lookup() on the
// runtime scope chain, exactly as the interpreter resolves it, so includes
// still see the caller's loops. The scope objects are still built per loop
// iteration, because an include renders in the scope it is written in.

/** One own-property step of a path: the value, or undefined. */
function pv(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

const TPL_HELPERS = { esc, txt: textOf, truthy, lk: lookup, pv };

/** Compile `nodes` to (scope, depth, F) => string, or null when it cannot. */
function compileTemplate(nodes) {
  const paths = [];
  const pathIds = new Map();
  const pathId = (path) => {
    const key = path.join('.');
    let id = pathIds.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push(path);
      pathIds.set(key, id);
    }
    return id;
  };
  let counter = 0;
  const exprFor = (path, env, scopeVar) => {
    const head = path[0];
    for (let e = env.length - 1; e >= 0; e--) {
      if (env[e].name === head) {
        let ex = env[e].var;
        for (let k = 1; k < path.length; k++) ex = `H.pv(${ex},${JSON.stringify(path[k])})`;
        return ex;
      }
    }
    return `H.lk(${scopeVar},P[${pathId(path)}])`;
  };
  const gen = (list, env, scopeVar) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          if (n.text !== '') code += `o+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
          code += `o+=H.esc(H.txt(${exprFor(n.path, env, scopeVar)}));`;
          break;
        case 'raw':
          code += `o+=H.txt(${exprFor(n.path, env, scopeVar)});`;
          break;
        case 'if': {
          code += `if(H.truthy(${exprFor(n.path, env, scopeVar)})!==${n.not}){${gen(n.then, env, scopeVar)}}`;
          if (n.else !== null) code += `else{${gen(n.else, env, scopeVar)}}`;
          break;
        }
        case 'for': {
          const id = ++counter;
          const v = `__v${id}`;
          const kk = `__k${id}`;
          const el = `__e${id}`;
          const lp = `__l${id}`;
          const sc = `__s${id}`;
          const ln = `__n${id}`;
          code += `{const ${v}=${exprFor(n.path, env, scopeVar)};if(Array.isArray(${v})){const ${ln}=${v}.length;`;
          code += `for(let ${kk}=0;${kk}<${ln};${kk}++){const ${el}=${v}[${kk}];`;
          code += `const ${lp}={index:${kk}+1,first:${kk}===0,last:${kk}===${ln}-1,length:${ln}};`;
          code += `const ${sc}={vars:{[${JSON.stringify(n.name)}]:${el},loop:${lp}},parent:${scopeVar}};`;
          code += gen(n.body, [...env, { name: n.name, var: el }, { name: 'loop', var: lp }], sc);
          code += '}}}';
          break;
        }
        case 'include':
          code += `if(depth<${INCLUDE_DEPTH}){const __f=F[${JSON.stringify(n.name)}];if(__f!==undefined)o+=__f(${scopeVar},depth+1,F);}`;
          break;
      }
    }
    return code;
  };
  let fn;
  try {
    fn = new Function('scope', 'depth', 'H', 'F', 'P', `let o='';${gen(nodes, [], 'scope')}return o;`);
  } catch {
    return null;
  }
  return (scope, depth, F) => fn(scope, depth, TPL_HELPERS, F, paths);
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a URI scheme. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let j = 1; j < target.length; j++) {
    const c = target.charCodeAt(j);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let hit = slugCache.get(text);
    if (hit === undefined) {
      hit = slugifyRaw(text);
      slugCache.set(text, hit);
    }
    return hit;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit order of path; .md files are sources, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slugs unique per directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken.get(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with each source's link targets memoised.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const env = {
      link: (target) => {
        const hit = linkCache.get(target);
        if (hit !== undefined) return hit;
        let result;
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
          result = target;
        } else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) result = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) result = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            result = target;
          }
        }
        linkCache.set(target, result);
        return result;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags, grouped by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages. The per-source pieces templates read again and again
  // (the long date, the tag cards, the neighbour link) are built once per
  // source and shared: rendering only ever reads them.
  for (const s of kept) {
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    s.cardTags = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.linkObj = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong };
  }
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.cardTags,
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const cardFor = (s) => cards.get(s) ?? cardOf(s);
  const pageOf = (s) => ({
    ...cardFor(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer ? s.newer.linkObj : null,
    older: s.older ? s.older.linkObj : null,
    is_post: s.post,
  });

  // Layouts: pages, index pages, tag pages, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const compiled = {};
  for (const [name, nodes] of templates) {
    compiled[name] = compileTemplate(nodes) ?? ((scope, depth) => renderNodes(nodes, scope, ctx, depth));
  }
  const render = (name, vars) => {
    const fn = compiled[name];
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, compiled);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', { tag });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
