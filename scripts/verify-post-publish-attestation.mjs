#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  evaluatePostPublishAttestation,
  HANDOFF_CONTRACT_FILES,
  sha256,
} from './post-publish-attestation-core.mjs';

function parseArgs(argv) {
  const args = { url: '', expectedReleaseSha: null, waitMs: 180_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--') && !args.url) args.url = value;
    else if (value === '--expected-release') args.expectedReleaseSha = argv[++i] ?? null;
    else if (value === '--wait-ms') args.waitMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!/^https:\/\/[^/]+/.test(args.url)) throw new Error('A public HTTPS deployment URL is required');
  if (!/^[0-9a-f]{40}$/.test(args.expectedReleaseSha ?? '')) {
    throw new Error('--expected-release with the reviewed 40-character Git SHA is required');
  }
  if (!Number.isFinite(args.waitMs) || args.waitMs < 0 || args.waitMs > 10 * 60_000) {
    throw new Error('--wait-ms must be between 0 and 600000');
  }
  return args;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function deriveExpectedSource(releaseSha) {
  execFileSync('git', ['cat-file', '-e', `${releaseSha}^{commit}`], { stdio: 'ignore' });
  const expectedProductTree = git(['rev-parse', `${releaseSha}^{tree}`]).toLowerCase();
  const parts = HANDOFF_CONTRACT_FILES.map((path) =>
    `${path}\0${git(['show', `${releaseSha}:${path}`])}`);
  return {
    expectedProductTree,
    expectedHandoffSha256: sha256(parts.join('\0')),
  };
}

async function request(base, pathname, kind = 'json', redirect = 'follow') {
  try {
    const response = await fetch(new URL(pathname, base), {
      method: 'GET',
      redirect,
      signal: AbortSignal.timeout(15_000),
      headers: { accept: kind === 'json' ? 'application/json' : 'text/html' },
    });
    const body = kind === 'json' ? await response.json() : await response.text();
    return { status: response.status, location: response.headers.get('location'), body };
  } catch (error) {
    return { unavailable: true, error: error instanceof Error ? error.message : 'request failed' };
  }
}

async function collect(base) {
  const [health, root, web, identity, safety, signer, subaccount, positions] = await Promise.all([
    request(base, '/api/healthz'),
    request(base, '/', 'text', 'manual'),
    request(base, '/futures-web/', 'text'),
    request(base, '/api/release/identity'),
    request(base, '/api/release/safety'),
    request(base, '/api/executor/signer'),
    request(base, '/api/executor/subaccount-auth'),
    request(base, '/api/gmx/positions'),
  ]);
  const assets = [];
  if (identity.body?.identity?.webAssets) {
    for (const asset of identity.body.identity.webAssets) {
      try {
        const response = await fetch(new URL(asset.path, base), {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        assets.push({ path: asset.path, sha256: sha256(Buffer.from(await response.arrayBuffer())) });
      } catch {
        // Missing asset remains absent; evaluator reports fail-closed mismatch.
      }
    }
  }
  return { health, root, web, identity, safety, signer, subaccount, positions, assets };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expected = deriveExpectedSource(args.expectedReleaseSha);
  const deadline = Date.now() + args.waitMs;
  let collected;
  let report;
  do {
    collected = await collect(args.url);
    report = evaluatePostPublishAttestation({
      ...collected,
      expectedReleaseSha: args.expectedReleaseSha,
      expectedProductTree: expected.expectedProductTree,
      expectedHandoffSha256: expected.expectedHandoffSha256,
    });
    if (report.overall === 'PASS' || Date.now() >= deadline) break;
    const schedulerChecks = report.runtimeSafety.checks.filter((item) =>
      item.id === 'scheduler-cycle' || item.id === 'cold-start-recovered');
    if (schedulerChecks.length !== 2 || schedulerChecks.every((item) => item.status === 'PASS')) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  } while (Date.now() < deadline);
  console.log(JSON.stringify({
    target: args.url,
    expectedReleaseSha: args.expectedReleaseSha,
    expectedProductTree: expected.expectedProductTree,
    expectedHandoffSha256: expected.expectedHandoffSha256,
    ...report,
  }, null, 2));
  process.exitCode = report.overall === 'PASS' ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    overall: 'UNAVAILABLE',
    error: error instanceof Error ? error.message : 'attestation failed',
  }, null, 2));
  process.exitCode = 1;
});