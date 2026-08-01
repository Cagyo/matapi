import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../../..');
const legacyBinary = ['r', 'clone'].join('');
const legacyPrefixes = [
  `${legacyBinary.toUpperCase()}_`,
  ['GDRIVE', 'REMOTE', ''].join('_'),
];
const forbidden = new RegExp(
  `\\b${legacyBinary}\\b|${legacyPrefixes.join('|')}`,
  'iu',
);
const textExtensions = new Set([
  '.cjs', '.js', '.json', '.md', '.sh', '.ts', '.yml', '.yaml',
]);

function activeFiles(): string[] {
  const roots = ['config', 'docs', 'scripts', 'src', 'test'];
  const files = ['package.json'];
  for (const root of roots) visit(resolve(repositoryRoot, root), files);
  return files.sort();
}

function visit(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const repositoryPath = relative(repositoryRoot, absolute);
    if (entry.isDirectory()) {
      if (repositoryPath === 'docs/superpowers' || entry.name === '__pycache__') continue;
      visit(absolute, files);
      continue;
    }
    if (textExtensions.has(extname(entry.name))) files.push(repositoryPath);
  }
}

describe('legacy Google Drive integration removal', () => {
  it('has no active runtime, installer, config, test, locale, or documentation path', () => {
    const remnants = activeFiles().flatMap((file) => {
      const lines = readFileSync(resolve(repositoryRoot, file), 'utf8').split('\n');
      return lines.flatMap((line, index) =>
        forbidden.test(line) ? [`${file}:${index + 1}:${line.trim()}`] : [],
      );
    });

    expect(remnants).toEqual([]);
  });
});
