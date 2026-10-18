#!/usr/bin/env node
/**
 * PhishGuard Version Control System
 *
 * Automatically increments 0.1.X patch versions on project rebuilds,
 * keeping extension manifests, package.json files, HTML fallbacks, and
 * product facts synchronized.
 *
 * Usage:
 *   node scripts/bump-version.mjs              # Auto-increments patch version (0.1.X -> 0.1.(X+1))
 *   node scripts/bump-version.mjs --current    # Outputs current version (e.g. 0.1.1)
 *   node scripts/bump-version.mjs --dry-run    # Computes next version without writing
 *   node scripts/bump-version.mjs --set 0.1.5  # Sets explicit 0.1.X version
 *   node scripts/bump-version.mjs --reset      # Resets back to 0.1.0
 *   node scripts/bump-version.mjs --force      # Bypasses rebuild session debounce
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

const VERSION_FILE = resolve(ROOT_DIR, 'version.json');
const ROOT_PKG = resolve(ROOT_DIR, 'package.json');
const EXT_PKG = resolve(ROOT_DIR, 'apps/extension/package.json');
const EXT_MANIFEST = resolve(ROOT_DIR, 'apps/extension/manifest.json');
const EXT_POPUP_HTML = resolve(ROOT_DIR, 'apps/extension/popup/popup.html');
const EXT_DIST_DIR = resolve(ROOT_DIR, 'apps/extension/dist');
const LANDING_PKG = resolve(ROOT_DIR, 'apps/landing/package.json');
const LANDING_FACTS = resolve(ROOT_DIR, 'apps/landing/lib/facts.ts');
const TYPES_PKG = resolve(ROOT_DIR, 'packages/types/package.json');

// Session debounce window (ms): prevents multiple package steps in one `pnpm build` from multi-incrementing
const SESSION_DEBOUNCE_MS = 4000;

function getGitMeta() {
  let commit = 'unknown';
  let branch = 'unknown';
  let isDirty = false;
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT_DIR, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {}
  try {
    branch = execSync('git branch --show-current', { cwd: ROOT_DIR, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {}
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT_DIR, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    isDirty = status.length > 0;
  } catch {}
  return { commit, branch, isDirty };
}

function loadVersionData() {
  if (existsSync(VERSION_FILE)) {
    try {
      return JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
    } catch {}
  }
  return {
    version: '0.4.0',
    major: 0,
    minor: 4,
    patch: 0,
    buildNumber: 0,
    lastBuild: new Date(0).toISOString(),
    gitCommit: 'unknown',
    branch: 'unknown',
    history: [],
  };
}

function parseArgs(args) {
  const options = {
    action: 'increment',
    targetVersion: null,
    force: false,
    quiet: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--current') {
      options.action = 'current';
    } else if (arg === '--dry-run') {
      options.action = 'dry-run';
    } else if (arg === '--reset') {
      options.action = 'reset';
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--set' && args[i + 1]) {
      options.action = 'set';
      options.targetVersion = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.action = 'help';
    }
  }
  return options;
}

function updateJsonField(filePath, field, value) {
  if (!existsSync(filePath)) return;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    data[field] = value;
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error(`[PhishGuard Version] Error updating ${filePath}:`, err.message);
  }
}

function updateRegexFile(filePath, regex, replacement) {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, 'utf8');
    const updated = content.replace(regex, replacement);
    if (content !== updated) {
      writeFileSync(filePath, updated, 'utf8');
    }
  } catch (err) {
    console.error(`[PhishGuard Version] Error updating ${filePath}:`, err.message);
  }
}

function syncVersionAcrossTargets(newVersion) {
  // 1. Root & Workspace package.json files
  updateJsonField(ROOT_PKG, 'version', newVersion);
  updateJsonField(EXT_PKG, 'version', newVersion);
  updateJsonField(LANDING_PKG, 'version', newVersion);
  updateJsonField(TYPES_PKG, 'version', newVersion);

  // 2. Extension manifest.json
  updateJsonField(EXT_MANIFEST, 'version', newVersion);

  // 3. Extension popup fallback HTML
  updateRegexFile(
    EXT_POPUP_HTML,
    /(<span id="ext-version-text" class="value-strong">)v[^<]+(<\/span>)/g,
    `$1v${newVersion}$2`
  );

  // 4. Landing facts fallback
  updateRegexFile(
    LANDING_FACTS,
    /(extensionVersion:\s*")[^"]+(")/g,
    `$1${newVersion}$2`
  );

  // 5. Build output dist copy
  if (existsSync(EXT_DIST_DIR)) {
    try {
      const distVersionFile = resolve(EXT_DIST_DIR, 'version.json');
      writeFileSync(distVersionFile, JSON.stringify({ version: newVersion, builtAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    } catch {}
  }
}

function run() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.action === 'help') {
    console.log(`
PhishGuard Version Control System (0.1.X Auto-Increment)

Options:
  --current       Print current version and exit
  --dry-run       Preview next auto-incremented version without writing
  --set <ver>     Manually set version to 0.1.X
  --reset         Reset version back to 0.1.0
  --force         Force increment even if within rebuild debounce window
  -q, --quiet     Suppress non-error output
`);
    process.exit(0);
  }

  const current = loadVersionData();

  if (opts.action === 'current') {
    console.log(current.version || '0.1.0');
    process.exit(0);
  }

  // Check skip flags
  if (process.env.PHISHGUARD_SKIP_VERSION_BUMP === '1' || process.env.NO_BUMP === '1') {
    if (!opts.quiet) console.log(`[PhishGuard Version] Skipping bump (PHISHGUARD_SKIP_VERSION_BUMP=1). Current: v${current.version}`);
    process.exit(0);
  }

  const now = new Date();
  let major = current.major ?? 0;
  let minor = current.minor ?? 4;
  let patch = current.patch ?? 0;
  let buildNumber = current.buildNumber ?? 0;
  let nextVersion = current.version || `${major}.${minor}.${patch}`;

  if (opts.action === 'reset') {
    patch = 0;
    buildNumber = 0;
    nextVersion = `${major}.${minor}.${patch}`;
  } else if (opts.action === 'set') {
    const match = opts.targetVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      console.error(`[PhishGuard Version] Error: Target version must match X.Y.Z (e.g. 0.4.0). Got: ${opts.targetVersion}`);
      process.exit(1);
    }
    major = parseInt(match[1], 10);
    minor = parseInt(match[2], 10);
    patch = parseInt(match[3], 10);
    nextVersion = `${major}.${minor}.${patch}`;
  } else {
    // Default auto-increment on rebuild:
    const lastBuildTime = new Date(current.lastBuild || 0).getTime();
    const timeSinceLastBuild = now.getTime() - lastBuildTime;

    if (!opts.force && timeSinceLastBuild < SESSION_DEBOUNCE_MS) {
      // Re-use currently bumped version in this build session
      if (!opts.quiet) {
        console.log(`[PhishGuard Version] Using session version v${current.version} (bumped ${(timeSinceLastBuild / 1000).toFixed(1)}s ago)`);
      }
      syncVersionAcrossTargets(current.version);
      process.exit(0);
    }

    patch = patch + 1;
    buildNumber = buildNumber + 1;
    nextVersion = `${major}.${minor}.${patch}`;
  }

  if (opts.action === 'dry-run') {
    console.log(`[PhishGuard Version] Dry run: v${current.version} -> v${nextVersion} (build #${buildNumber})`);
    process.exit(0);
  }

  const gitMeta = getGitMeta();
  const history = Array.isArray(current.history) ? current.history.slice(-49) : [];
  history.push({
    version: nextVersion,
    buildNumber,
    timestamp: now.toISOString(),
    commit: gitMeta.commit,
  });

  const updatedData = {
    version: nextVersion,
    major,
    minor,
    patch,
    buildNumber,
    lastBuild: now.toISOString(),
    gitCommit: gitMeta.commit,
    branch: gitMeta.branch,
    isDirty: gitMeta.isDirty,
    history,
  };

  writeFileSync(VERSION_FILE, JSON.stringify(updatedData, null, 2) + '\n', 'utf8');
  syncVersionAcrossTargets(nextVersion);

  if (!opts.quiet) {
    console.log(`[PhishGuard Version] Auto-incremented to v${nextVersion} (build #${buildNumber}, commit: ${gitMeta.commit})`);
  }
}

run();
