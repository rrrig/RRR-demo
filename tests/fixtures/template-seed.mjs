// Файлы репозитория данных из data-template/ (projects, AGENTS.md, tools) для поддельного GitHub.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data-template');
export function templateFiles({ only = ['projects', 'AGENTS.md', 'README.md', 'tools'] } = {}) {
  const out = {};
  const walk = rel => {
    const abs = path.join(ROOT, rel);
    if (statSync(abs).isDirectory()) { for (const n of readdirSync(abs)) if (n !== 'node_modules') walk(rel ? rel + '/' + n : n); }
    else out[rel] = new Uint8Array(readFileSync(abs));
  };
  for (const x of only) walk(x);
  return out;
}
