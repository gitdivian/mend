// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. It also does sections 5 to 8:
// matching lines at three tiers, unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches
// (section 8). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** [old, new] pairs that a move edit moved, for section 2's R lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: a file as its line break, its lines and whether it ends with a break. ----

interface FileModel {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { br, lines: parts, fin };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

// ---- Section 5: matching lines at three tiers. ----

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Every position at which o occurs in lines at the tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  at: number[];
}

/** The first tier at which o occurs at or after `from` (for eof, only occurrences ending at the last line). */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0, eof = false): Match | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, o, tier).filter((i) => i >= from && (!eof || i + o.length === lines.length));
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** Section 5's tier-2 re-indent: a non-blank line starting with p has that prefix replaced by f. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface BodyLine {
  tag: string;
  text: string;
}

/** The lines a matched block writes: context lines as the file's own matched lines, new lines as written
 *  (re-indented at tier 2). The body's '\' lines write nothing. */
function buildBlock(body: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const oFirst = body.find((b) => b.tag === ' ' || b.tag === '-');
  const f = tier === 2 && oFirst !== undefined ? leadST(fileLines[at] ?? '') : '';
  const p = tier === 2 && oFirst !== undefined ? leadST(oFirst.text) : '';
  let k = at;
  for (const b of body) {
    if (b.tag === ' ') {
      out.push(fileLines[k]!);
      k += 1;
    } else if (b.tag === '-') {
      k += 1;
    } else if (b.tag === '+') {
      out.push(tier === 2 ? reindent(b.text, f, p) : b.text);
    }
  }
  return out;
}

/** Whether a '\' line follows the body's last context or '+' line (sections 6's final-break rule). */
function backslashAfterLastWrite(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) if (body[i]!.tag === ' ' || body[i]!.tag === '+') last = i;
  return last >= 0 && body[last + 1]?.tag === '\\';
}

// ---- Section 6: unified diffs. ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

function gitPaths(line: string, lineNo: number): { old: string; next: string } {
  const m = /^a\/(.*?) b\/(.*)$/.exec(line.slice('diff --git '.length));
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { old: m[1]!, next: m[2]! };
}

/** A --- or +++ line's path: after the four characters, up to the first tab, spaces removed; /dev/null is no file. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: (BodyLine & { empty: boolean })[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ tag: ' ', text: '', empty: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ tag: c, text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  return { hunk: { a: Number(m[1]), body }, next: j };
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function applySection(tree: Tree, s: Section, oldPath: string | null, newPath: string | null, strict: boolean): void {
  const create = oldPath === null || s.create;
  const del = newPath === null || s.del;
  if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
  if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
  if (create) {
    if (newPath === null) throw new Fail('unsafe', '');
    if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const out: string[] = [];
    let lastPlus: { body: BodyLine[]; idx: number } | null = null;
    for (const h of s.hunks) {
      h.body.forEach((b, idx) => {
        if (b.tag === '+') {
          out.push(b.text);
          lastPlus = { body: h.body, idx };
        }
      });
    }
    const fin = lastPlus === null || lastPlus.body[lastPlus.idx + 1]?.tag !== '\\';
    tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
    return;
  }
  if (del) {
    const p = oldPath!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const p = oldPath!;
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  if (newPath !== null && newPath !== p && tree.get(newPath) !== null) throw new Fail('exists', newPath);
  const model = splitFile(before);
  let d = 0;
  for (const h of s.hunks) {
    const o = h.body.filter((b) => b.tag === ' ' || b.tag === '-').map((b) => b.text);
    const nLen = h.body.filter((b) => b.tag === ' ' || b.tag === '+').length;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, model.lines.length));
      const block = h.body.filter((b) => b.tag === '+').map((b) => b.text);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...block);
      if (atEnd) model.fin = !backslashAfterLastWrite(h.body);
    } else {
      const found = findMatch(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      const target = h.a - 1 + d;
      let at = found.at[0]!;
      for (const cand of found.at) if (Math.abs(cand - target) < Math.abs(at - target)) at = cand;
      const block = buildBlock(h.body, model.lines, at, found.tier);
      const atEnd = at + o.length === model.lines.length;
      model.lines.splice(at, o.length, ...block);
      if (atEnd) model.fin = !backslashAfterLastWrite(h.body);
    }
    d += nLen - o.length;
  }
  const dest = newPath ?? p;
  tree.now.set(dest, joinFile(model));
  if (dest !== p) {
    tree.now.set(p, null);
    tree.moves.push([p, dest]);
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let header = false;
  const newSec = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, hasPair: false, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    secs.push(s);
    cur = s;
    header = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = gitPaths(l, i + 1);
      const s = newSec();
      s.gitOld = g.old;
      s.gitNew = g.next;
      i += 1;
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.hasPair) newSec();
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const { hunk, next } = parseHunk(lines, i);
        cur.hunks.push(hunk);
        header = false;
        i = next;
        continue;
      }
      i += 1; // any other header line is ignored
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('@@')) {
        const { hunk, next } = parseHunk(lines, i);
        cur.hunks.push(hunk);
        i = next;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSec();
        continue;
      }
      i += 1; // lines outside bodies are ignored
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      newSec();
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    i += 1; // prose is ignored
  }
  return secs.map((s) => {
    const oldPath = s.hasPair ? s.pairOld : s.renOld ?? s.gitOld;
    const newPath = s.hasPair ? s.pairNew : s.renNew ?? s.gitNew;
    return (tree: Tree) => applySection(tree, s, oldPath, newPath, strict);
  });
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    add: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${s + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), add: lines.slice(eq + 1, rp) });
    prevEnd = rp + 1;
    i = rp + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.add.length === 0 ? '' : b.add.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const found = findMatch(model.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.at[0]!;
    const block = found.tier === 2 ? b.add.map((l) => reindent(l, leadST(model.lines[at]!), leadST(b.old[0]!))) : b.add;
    model.lines.splice(at, b.old.length, ...block);
    tree.now.set(b.path, joinFile(model));
  });
}

// ---- Section 8: V4A patches. ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function applyUpdate(tree: Tree, p: string, moveTo: string | null, chunks: Chunk[], strict: boolean): void {
  if (!safe(p)) throw new Fail('unsafe', p);
  if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  const model = splitFile(before);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let at = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let k = cursor; k < model.lines.length; k += 1) {
          if (lineEq(model.lines[k]!, chunk.anchor, tier)) {
            at = k;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', p);
      cursor = at + 1;
    }
    const o = chunk.body.filter((b) => b.tag === ' ' || b.tag === '-').map((b) => b.text);
    if (o.length === 0) {
      const block = chunk.body.filter((b) => b.tag === '+').map((b) => b.text);
      const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
      model.lines.splice(at, 0, ...block);
      cursor = at + block.length;
    } else {
      const found = findMatch(model.lines, o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', p);
      const at = found.at[0]!;
      const block = buildBlock(chunk.body, model.lines, at, found.tier);
      model.lines.splice(at, o.length, ...block);
      cursor = at + block.length;
    }
  }
  if (moveTo !== null) {
    tree.now.set(moveTo, joinFile(model));
    tree.now.set(p, null);
    tree.moves.push([p, moveTo]);
  } else {
    tree.now.set(p, joinFile(model));
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j > first; j -= 1) {
    if (!blank(lines[j])) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: [string, string][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  const headOf = (l: string): { kind: string; path: string } | null => {
    for (const [pre, kind] of heads) if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = headOf(lines[i]!);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    let j = i + 1;
    while (j < last && headOf(lines[j]!) === null) j += 1;
    const bodyIdx: number[] = [];
    for (let k = i + 1; k < j; k += 1) bodyIdx.push(k);
    while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
    i = j;
    if (head.kind === 'add') {
      const fileLines: string[] = [];
      for (const k of bodyIdx) {
        const l = lines[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      const p = head.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (head.kind === 'del') {
      for (const k of bodyIdx) if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      const p = head.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let start = 0;
      if (bodyIdx.length > 0 && lines[bodyIdx[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[bodyIdx[0]!]!.slice('*** Move to: '.length).trim();
        start = 1;
      }
      for (let n = start; n < bodyIdx.length; n += 1) {
        const k = bodyIdx[n]!;
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          const t = l.slice(2).trim();
          cur = { anchor: t === '' ? null : t, eof: false, body: [] };
          chunks.push(cur);
        } else if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ tag: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      const p = head.path;
      const mv = moveTo;
      edits.push((tree: Tree) => applyUpdate(tree, p, mv, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const keyed: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (used.has(oldP) || used.has(newP)) continue;
    if (tree.original(oldP) === null || state(oldP) !== null) continue;
    if (tree.original(newP) !== null || state(newP) === null) continue;
    used.add(oldP);
    used.add(newP);
    keyed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
