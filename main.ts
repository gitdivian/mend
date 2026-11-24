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
  /** A directory at p: one on disk, or one the edits imply by placing a file under p. A directory is
   *  not a file (get reads it as absent), but a creation there, or a move there, runs into it. */
  isDir(p: string): boolean {
    try {
      if (statSync(p).isDirectory()) return true;
    } catch {
      // not on disk
    }
    const pre = `${p}/`;
    for (const [k, v] of this.now) if (v !== null && k.startsWith(pre)) return true;
    return false;
  }
  /** A file sitting where a parent directory of p would have to be, in the tree as the edits leave it. */
  parentIsFile(p: string): boolean {
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) {
      if (this.get(p.slice(0, i)) !== null) return true;
    }
    return false;
  }
  /** What a creation at p, or a move to p, runs into: a file at p, a directory at p, or a file in
   *  place of one of p's parent directories. Any of them is the spec's `exists` for that edit. */
  createBlocked(p: string): boolean {
    return this.get(p) !== null || this.isDir(p) || this.parentIsFile(p);
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
