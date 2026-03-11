import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const projectDirs = ['apps', 'packages', 'libs'];

type Diagnostic = { level: 'ERROR' | 'WARN'; message: string };
type ProjectResult = { path: string; diagnostics: Diagnostic[] };

const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, 'utf8')) as T;

const stripScope = (name: string): string => name.replace(/^@[^/]+\//, '');

const discoverProjects = (): string[] => {
  const projects: string[] = [];

  for (const dir of projectDirs) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(absDir, entry.name);
      if (existsSync(join(projectDir, 'project.json'))) {
        projects.push(projectDir);
      }
    }
  }

  return projects;
};

const validateProject = (projectDir: string): ProjectResult => {
  const relativePath = projectDir.replace(root + '/', '');
  const diagnostics: Diagnostic[] = [];

  const nxPath = join(projectDir, 'project.json');
  const pkgPath = join(projectDir, 'package.json');

  const nxConfig = readJson<{ name?: string }>(nxPath);
  const dirName = basename(projectDir);

  if (!nxConfig.name) {
    diagnostics.push({ level: 'ERROR', message: 'project.json missing "name" field' });
    return { path: relativePath, diagnostics };
  }

  if (nxConfig.name !== dirName) {
    diagnostics.push({
      level: 'ERROR',
      message: `project.json name "${nxConfig.name}" does not match directory name "${dirName}"`,
    });
  }

  if (existsSync(pkgPath)) {
    const pkg = readJson<{ name?: string }>(pkgPath);
    if (!pkg.name) {
      diagnostics.push({ level: 'ERROR', message: 'package.json missing "name" field' });
    } else {
      const pkgShortName = stripScope(pkg.name);
      if (nxConfig.name !== pkgShortName) {
        diagnostics.push({
          level: 'ERROR',
          message: `project.json name "${nxConfig.name}" does not match package.json name "${pkg.name}" (unscoped: "${pkgShortName}")`,
        });
      }
    }
  }

  return { path: relativePath, diagnostics };
};

const projects = discoverProjects();
const results = projects.map(validateProject);

let errors = 0;
let warnings = 0;

for (const { path, diagnostics } of results) {
  if (diagnostics.length === 0) continue;

  console.log(`\n${path}`);
  for (const d of diagnostics) {
    const prefix = d.level === 'ERROR' ? '  \x1B[31mERROR\x1B[0m' : '  \x1B[33mWARN\x1B[0m ';
    console.log(`${prefix}  ${d.message}`);
    if (d.level === 'ERROR') {
      errors++;
    } else {
      warnings++;
    }
  }
}

const totalProjects = projects.length;
console.log(
  `\nSummary: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} across ${totalProjects} projects`,
);

if (errors > 0) {
  process.exit(1);
}
