import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const artifactsDir = new URL('artifacts/', root);
const productionArtifacts = [];

for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(artifactsDir.pathname, entry.name, '.replit-artifact', 'artifact.toml');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (/^\[services\.production(?:\.|\])/m.test(text)
      || /^\[\[services\.production\./m.test(text)) {
    productionArtifacts.push(entry.name);
  }
}

if (productionArtifacts.length !== 1 || productionArtifacts[0] !== 'api-server') {
  throw new Error(
    `Production topology must contain only api-server; found: ${productionArtifacts.join(', ') || 'none'}`,
  );
}

const apiArtifact = readFileSync(
  new URL('artifacts/api-server/.replit-artifact/artifact.toml', root),
  'utf8',
);
if (!apiArtifact.includes('artifacts/api-server/dist/index.mjs')
    || !apiArtifact.includes('PORT = "8080"')) {
  throw new Error('api-server Production service must own the single port 8080 process');
}
if (!/paths\s*=\s*\[[^\]]*"\/futures-web\/"[^\]]*"\/"[^\]]*\]/m.test(apiArtifact)) {
  throw new Error('api-server must route both /futures-web/ and the root fallback');
}

const webArtifact = readFileSync(
  new URL('artifacts/futures-web/.replit-artifact/artifact.toml', root),
  'utf8',
);
if (/^\s*paths\s*=\s*\[[^\]]*"\/futures-web\/"/m.test(webArtifact)) {
  throw new Error('futures-web development artifact must not claim the Production /futures-web/ route');
}

const rootReplit = readFileSync(new URL('.replit', root), 'utf8');
if (!rootReplit.includes('run = ["pnpm", "run", "start:deploy"]')) {
  throw new Error('.replit deployment must use the single start:deploy entrypoint');
}

const postPublishWorkflow = readFileSync(
  new URL('.github/workflows/post-publish-attestation.yml', root),
  'utf8',
);
for (const required of [
  'deployment_status:',
  'workflow_dispatch:',
  'schedule:',
  'verify-post-publish-attestation.mjs',
  '--expected-release',
  'upload-artifact@v4',
]) {
  if (!postPublishWorkflow.includes(required)) {
    throw new Error(`post-publish attestation automation missing: ${required}`);
  }
}

console.log('Deployment topology verified: api-server owns port 8080 and all Production web routes');
