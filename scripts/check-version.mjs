// Release guard: the git tag (v1.2.3) must match manifest.json and package.json versions.
//   node scripts/check-version.mjs v0.2.0
import { readFileSync } from 'node:fs';

const tag = (process.argv[2] || process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const problems = [];
if (!tag) problems.push('no tag given');
if (manifest !== pkg) problems.push(`manifest.json is ${manifest} but package.json is ${pkg}`);
if (tag && tag !== manifest) problems.push(`tag is ${tag} but manifest.json is ${manifest}`);
if (problems.length) {
  console.error(`Version check failed: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`Version ${manifest} matches the tag.`);
