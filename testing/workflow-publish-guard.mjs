// The npm publish job must not run after a failed Create Release run.
// A workflow_run trigger fires on every completed run, so the job needs a
// conclusion guard. Run: node testing/workflow-publish-guard.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? join(root, '.github/workflows/npm-publish.yml');
const yml = readFileSync(file, 'utf8');

const job = yml.split(/^jobs:\s*$/m)[1]?.match(/^  publish-npm:\r?\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m)?.[1];
if (!job) {
    console.log(`FAIL: no publish-npm job found in ${file}`);
    process.exit(1);
}
const triggersOnRun = /^\s*workflow_run:/m.test(yml);
const guarded = /^\s*if:.*workflow_run\.conclusion\s*==\s*'success'/m.test(job);

if (triggersOnRun && !guarded) {
    console.log('FAIL: publish-npm runs on every completed Create Release run, failed ones included');
    process.exit(1);
}
console.log('PASS: publish-npm is skipped when Create Release did not succeed');
