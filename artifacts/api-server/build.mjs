import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(artifactDir, "../..");

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFETY_CONTRACT_VERSION = "post-publish-safety/v1";
const HANDOFF_CONTRACT_VERSION = "confirmed-open-initial-stop/v1";
const HANDOFF_CONTRACT_FILES = [
  "artifacts/api-server/src/lib/confirmedOpenStopHandoff.ts",
  "artifacts/api-server/src/lib/gmxApiSubmitFlow.ts",
  "artifacts/api-server/src/lib/protectionOrders.ts",
  "artifacts/api-server/src/lib/relayLifecycle.ts",
  "artifacts/api-server/src/workers/liveTestExecutor.ts",
  "artifacts/api-server/src/workers/protectionExecutor.ts",
  "artifacts/api-server/src/__tests__/confirmedOpenStopHandoff.test.ts",
  "artifacts/api-server/src/__tests__/gmxApiPrepareDurability.test.ts",
  "artifacts/api-server/src/__tests__/gmxApiStatusReconciler.test.ts",
  "artifacts/api-server/src/__tests__/protection6h2b.lifecycle.test.ts",
];
const CRITICAL_RELEASE_PATHS = [
  ".github/workflows/ci.yml",
  ".replit",
  "pnpm-lock.yaml",
  "package.json",
  "artifacts/api-server/build.mjs",
  "artifacts/api-server/package.json",
  "artifacts/api-server/src/lib",
  "artifacts/api-server/src/routes/canary.ts",
  "artifacts/api-server/src/routes/gmxapi.ts",
  "artifacts/api-server/src/routes/livetest.ts",
  "artifacts/api-server/src/workers/liveTestExecutor.ts",
  "artifacts/api-server/src/workers/protectionExecutor.ts",
  "lib/db",
];
const PRODUCT_RELEASE_PATHS = [
  ".github",
  ".replit",
  "package.json",
  "pnpm-lock.yaml",
  "scripts",
  "lib",
  "artifacts/api-server",
  "artifacts/futures-web",
  "artifacts/futures-terminal",
];

function git(args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function githubEventHeadSha() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const sha = event?.pull_request?.head?.sha;
    return typeof sha === "string" ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

function handoverRefShas() {
  try {
    const refs = git([
      "for-each-ref",
      "--format=%(objectname)",
      "refs/remotes/*/codex/handover-20260820",
    ]);
    return refs ? refs.split(/\r?\n/).map((sha) => sha.toLowerCase()) : [];
  } catch {
    return [];
  }
}

function headParentShas() {
  try {
    const fields = git(["rev-list", "--parents", "-n", "1", "HEAD"])
      .toLowerCase()
      .split(/\s+/);
    return fields.slice(1);
  } catch {
    return [];
  }
}

function resolveReleaseSha() {
  const candidates = [
    githubEventHeadSha(),
    ...handoverRefShas(),
    ...headParentShas(),
    (() => { try { return git(["rev-parse", "HEAD"]).toLowerCase(); } catch { return null; } })(),
  ];
  for (const sha of [...new Set(candidates)]) {
    if (typeof sha !== "string" || !RELEASE_SHA_PATTERN.test(sha)) continue;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["diff", "--quiet", sha, "--", ...CRITICAL_RELEASE_PATHS], {
        cwd: repoDir,
        stdio: "ignore",
      });
      execFileSync("git", ["diff", "--quiet", sha, "--", ...PRODUCT_RELEASE_PATHS], {
        cwd: repoDir,
        stdio: "ignore",
      });
      const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...PRODUCT_RELEASE_PATHS]);
      if (untracked) continue;
      return sha;
    } catch {
      // A stale tracking ref or PR merge parent may legitimately differ. Try the
      // next locally available candidate, but never accept one with a critical diff.
    }
  }
  throw new Error("Canary release SHA could not be bound to the local security-critical source");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildHandoffContract(releaseSha) {
  const parts = HANDOFF_CONTRACT_FILES.map((relativePath) => {
    const source = git(["show", `${releaseSha}:${relativePath}`]);
    return `${relativePath}\0${source}`;
  });
  const joined = parts.join("\0");
  if (!joined.includes("sourceOpenTaskId")
      || !joined.includes("allowedBlockingSourceOpen")
      || !joined.includes("GENERAL_INTENT_ID")
      || !joined.includes("EMERGENCY_CLOSE")) {
    throw new Error("Task #140 confirmed OPEN handoff safety contract is incomplete");
  }
  return {
    version: HANDOFF_CONTRACT_VERSION,
    sha256: sha256(joined),
    files: [...HANDOFF_CONTRACT_FILES],
  };
}

function readWebAssets() {
  const indexPath = path.resolve(repoDir, "artifacts/futures-web/dist/public/index.html");
  const html = readFileSync(indexPath, "utf8");
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)]
    .map((match) => match[1]);
  if (paths.length < 2) throw new Error("Production Web asset manifest is incomplete");
  return [...new Set(paths)].sort().map((publicPath) => ({
    path: publicPath,
    sha256: sha256(readFileSync(path.resolve(repoDir, `artifacts/futures-web/dist/public${publicPath}`))),
  }));
}

function buildReleaseIdentity(releaseSha) {
  const productTree = git(["rev-parse", `${releaseSha}^{tree}`]).toLowerCase();
  const workspaceHeadSha = git(["rev-parse", "HEAD"]).toLowerCase();
  const workspaceProductTree = git(["rev-parse", "HEAD^{tree}"]).toLowerCase();
  if (!RELEASE_SHA_PATTERN.test(productTree)) {
    throw new Error("Product tree could not be bound to the release commit");
  }
  const builtAt = new Date().toISOString();
  const handoff = buildHandoffContract(releaseSha);
  const webAssets = readWebAssets();
  const identityBasis = JSON.stringify({
    releaseSha,
    productTree,
    workspaceSource: { headSha: workspaceHeadSha, productTree: workspaceProductTree },
    safetyContractVersion: SAFETY_CONTRACT_VERSION,
    handoff,
    webAssets,
    topology: { processCount: 1, port: 8080, owner: "api-server" },
  });
  return {
    schemaVersion: 1,
    releaseSha,
    productTree,
    buildId: sha256(`${identityBasis}\0${builtAt}`),
    builtAt,
    workspaceSource: { headSha: workspaceHeadSha, productTree: workspaceProductTree },
    safetyContract: {
      version: SAFETY_CONTRACT_VERSION,
      confirmedOpenInitialStop: handoff,
    },
    topology: { processCount: 1, port: 8080, owner: "api-server" },
    webAssets,
  };
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });
  const canaryReleaseSha = resolveReleaseSha();
  const releaseIdentity = buildReleaseIdentity(canaryReleaseSha);

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    define: {
      __CANARY_RELEASE_SHA__: JSON.stringify(canaryReleaseSha),
      __RELEASE_IDENTITY__: JSON.stringify(releaseIdentity),
    },
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
