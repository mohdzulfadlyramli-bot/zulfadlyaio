import { join } from 'node:path';
import { preparedBuild, run } from './build.mjs';

try {
  const { destination, revision } = preparedBuild();
  console.log(`Deploying Rill source: ${revision}`);
  run(process.execPath, [
    join(destination, 'node_modules/wrangler/bin/wrangler.js'),
    'deploy', '--keep-vars', ...process.argv.slice(2),
  ], destination);
} catch (error) {
  console.error(`Rill deployment failed: ${error.message}`);
  process.exitCode = 1;
}
