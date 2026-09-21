import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'https://github.com/mrtxiv/Rill.git';

export function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd, stdio: 'inherit',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// Build in a separate checkout: Cloudflare imports need no shared Git history,
// and rebuilding must never replace an installation's settings or local edits.
export function prepareBuild({ root = process.cwd(), upstream = UPSTREAM, execute = run } = {}) {
  const destination = join(root, '.rill-build');
  rmSync(destination, { recursive: true, force: true });
  try {
    const config = join(root, 'wrangler.jsonc');
    if (!existsSync(config)) throw new Error('The installation is missing wrangler.jsonc.');
    execute('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', upstream, destination], root);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: destination, encoding: 'utf8' }).trim();
    copyFileSync(config, join(destination, 'wrangler.jsonc'));
    console.log(`Rill source: ${revision}`);
    execute('npm', ['ci', '--no-audit', '--no-fund'], destination);
    execute('npm', ['run', 'typecheck'], destination);
    // Written only after every preparation step succeeds. Failed builds must
    // never leave a previously prepared version available for deployment.
    writeFileSync(join(destination, '.rill-ready.json'), JSON.stringify({ revision }));
    return { destination, revision };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function preparedBuild(root = process.cwd()) {
  const destination = join(root, '.rill-build');
  const marker = join(destination, '.rill-ready.json');
  if (!existsSync(marker)) throw new Error('Run npm run build before deploying.');
  const { revision } = JSON.parse(readFileSync(marker, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid prepared build. Run npm run build again.');
  return { destination, revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { prepareBuild(); }
  catch (error) { console.error(`Rill build failed: ${error.message}`); process.exitCode = 1; }
}
