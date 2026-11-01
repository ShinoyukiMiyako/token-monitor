'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudeSessionRoots } = require('./providers/claude/paths');
const { codebuddyProjectsRoot } = require('./providers/codebuddy/paths');
const { resolvePiSessionsDir } = require('./providers/pi/paths');
const { resolveOmpSessionsDir } = require('./providers/omp/paths');
const { findOmpSubagentSessionFile } = require('./providers/omp/subagents');
const { resolveSenpiSessionsDirs } = require('./providers/senpi/paths');
const { findSubagentSessionFile } = require('./providers/codebuddy/subagents');

// 5.5 moved the WorkBuddy home to ~/.workbuddy-ai and tokscale still scans
// both, so a session reported from either root resolves from either.
function workbuddyProjectsRoots(home) {
  return [path.join(home, '.workbuddy', 'projects'), path.join(home, '.workbuddy-ai', 'projects')];
}

function isSafeSessionId(sessionId) {
  const id = String(sessionId || '');
  if (!id || id === '.' || id === '..') return false;
  if (id.includes('\0')) return false;
  // A single path segment only — separators would let path.join walk out.
  if (/[\\/]/.test(id)) return false;
  return path.basename(id) === id;
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// `root` + separator + `<sessionId>.jsonl` -> the transcript's path.
//
// Session metadata is resolved again on every tick, and without this each of
// those ticks re-walked the whole tree to find files it had already found:
// 56ms of synchronous readdirSync over a real ~/.claude/projects (943 dirs /
// 10.5k files), growing with every session ever recorded. A transcript does not
// move once written, so remembering where it was turns the walk into a stat.
// Keyed by root rather than by client so the callers' own precedence between
// roots (projects before transcripts) is still decided by which root they ask.
//
// Module-level because it has to outlive a single collection to do anything.
const sessionFilePathCache = new Map();
// A character that cannot occur in a path or a file name, built rather than
// written as a literal so the source keeps no raw NUL byte.
const SESSION_FILE_KEY_SEPARATOR = String.fromCharCode(0);

function findSessionFiles(root, sessionIds) {
  const wanted = new Set();
  const found = new Map();
  for (const sessionId of sessionIds) {
    if (!isSafeSessionId(sessionId)) continue;
    const key = [root, sessionId].join(SESSION_FILE_KEY_SEPARATOR);
    const cached = sessionFilePathCache.get(key);
    if (cached) {
      // A remembered path that no longer reads is looked up again instead of
      // being trusted: the session may have been deleted, or moved with its
      // project directory.
      let isFile = false;
      try { isFile = fs.statSync(cached).isFile(); } catch (_) { /* gone */ }
      if (isFile) { found.set(sessionId, cached); continue; }
      sessionFilePathCache.delete(key);
    }
    wanted.add(`${sessionId}.jsonl`);
  }
  if (wanted.size === 0) return found;
  const remembered = found.size;
  const remember = (sessionId, filePath) => {
    found.set(sessionId, filePath);
    sessionFilePathCache.set([root, sessionId].join(SESSION_FILE_KEY_SEPARATOR), filePath);
  };

  function walk(dir) {
    if (found.size - remembered >= wanted.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.size - remembered >= wanted.size) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        remember(entry.name.slice(0, -'.jsonl'.length), nextPath);
      }
    }
  }

  walk(root);
  return found;
}

// Pi and OMP name transcripts `<ISO-timestamp>_<sessionId>.jsonl`, so the id
// is a filename suffix rather than the whole basename matched by findSessionFiles.
function findTimestampedSessionFiles(root, sessionIds) {
  const wanted = new Map();
  for (const sessionId of sessionIds) {
    if (isSafeSessionId(sessionId)) wanted.set(`${sessionId}.jsonl`, sessionId);
  }
  const found = new Map();
  if (wanted.size === 0) return found;

  function walk(dir) {
    if (found.size >= wanted.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.size >= wanted.size) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile()) {
        for (const [filename, sessionId] of wanted) {
          if (entry.name === filename || entry.name.endsWith(`_${filename}`)) {
            found.set(sessionId, nextPath);
            break;
          }
        }
      }
    }
  }

  walk(root);
  return found;
}

function codexHomeDir(home, options = {}) {
  const env = options.env || process.env;
  const configured = options.useEnvRoots !== false ? String(env.CODEX_HOME || '').trim() : '';
  return configured ? path.resolve(configured) : path.join(home, '.codex');
}

function preferredCodexSessionFile(file) {
  const plain = String(file).replace(/\.jsonl\.zst$/, '.jsonl');
  if (!plain.endsWith('.jsonl')) return '';
  for (const candidate of [plain, `${plain}.zst`]) {
    try {
      const stat = candidate.endsWith('.zst') ? fs.lstatSync(candidate) : fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch (_) { /* Try the sibling. */ }
  }
  return '';
}

// Both spellings share the accounting key. Plain JSONL wins deterministically
// across roots; within one spelling, live sessions precede archived sessions.
function findCodexSessionFiles(codexHome, sessionIds) {
  const wanted = new Set([...sessionIds].filter(isSafeSessionId));
  const found = new Map();
  const ranks = new Map();
  let entriesLeft = 100_000;
  function walk(dir, rootRank, depth = 0) {
    if (depth > 32 || entriesLeft <= 0 || (found.size === wanted.size && [...ranks.values()].every(rank => rank === 0))) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (--entriesLeft < 0) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, rootRank, depth + 1);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
        const id = entry.name.replace(/\.jsonl(?:\.zst)?$/, '');
        const rank = (entry.name.endsWith('.zst') ? 2 : 0) + rootRank;
        if (wanted.has(id) && (!found.has(id) || rank < ranks.get(id))) {
          found.set(id, file);
          ranks.set(id, rank);
        }
      }
    }
  }
  if (wanted.size) {
    walk(path.join(codexHome, 'sessions'), 0);
    walk(path.join(codexHome, 'archived_sessions'), 1);
  }
  return found;
}

function codexSessionFile(home, sessionId, options = {}) {
  if (!isSafeSessionId(sessionId)) return '';
  const match = String(sessionId).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return '';
  const codexHome = options.codexHome || codexHomeDir(home, options);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const filePath = path.join(sessionsRoot, match[1], match[2], match[3], `${sessionId}.jsonl`);
  if (!isPathInside(sessionsRoot, filePath)) return '';
  const archivedRoot = path.join(codexHome, 'archived_sessions');
  const archived = path.join(archivedRoot, match[1], match[2], match[3], `${sessionId}.jsonl`);
  const flatArchived = path.join(archivedRoot, `${sessionId}.jsonl`);
  for (const suffix of ['', '.zst']) for (const candidate of [filePath, archived, flatArchived]) {
    try {
      const stat = suffix ? fs.lstatSync(candidate + suffix) : fs.statSync(candidate);
      if (stat.isFile()) return candidate + suffix;
    } catch (_) { /* Try the next location. */ }
  }
  return '';
}

function resolveSessionFile(client, sessionId, home, options = {}) {
  const id = String(sessionId || '');
  if (!isSafeSessionId(id)) return '';
  if (client === 'claude') {
    const { projects, transcripts } = claudeSessionRoots({
      homeDir: home,
      env: options.env,
      useEnvRoots: options.useEnvRoots
    });
    const projectFile = findSessionFiles(projects, [id]).get(id);
    if (projectFile) return projectFile;
    return findSessionFiles(transcripts, [id]).get(id) || '';
  }
  if (client === 'codebuddy') {
    const projectsRoot = codebuddyProjectsRoot({ homeDir: home });
    // A sub-agent conversation is the scan's own reported session, but its file
    // is named after the agent id, so the name-based lookup cannot find it. The
    // fallback reads the first record of each sub-agent transcript and runs only
    // when the session's own file is absent — a parent session always resolves
    // to its own transcript, and the collector's per-tick path, which calls
    // findSessionFiles directly, is untouched. Sub-agent usage stays the scan's
    // separate sessions; nothing here merges it into the parent.
    return findSessionFiles(projectsRoot, [id]).get(id)
      || findSubagentSessionFile(projectsRoot, id, { fs: options.fs })
      || '';
  }
  if (client === 'workbuddy') {
    for (const root of workbuddyProjectsRoots(home)) {
      const found = findSessionFiles(root, [id]).get(id);
      if (found) return found;
    }
    return '';
  }
  if (client === 'codex') {
    const codexHome = options.codexHome || codexHomeDir(home, options);
    const direct = codexSessionFile(home, id, { codexHome });
    if (direct) return direct;
    return findCodexSessionFiles(codexHome, [id]).get(id) || '';
  }
  if (client === 'pi') {
    const sessionsDir = resolvePiSessionsDir({ homeDir: home });
    return findTimestampedSessionFiles(sessionsDir, [id]).get(id) || '';
  }
  if (client === 'omp') {
    const sessionsDir = resolveOmpSessionsDir({ homeDir: home });
    return findTimestampedSessionFiles(sessionsDir, [id]).get(id)
      || findOmpSubagentSessionFile(sessionsDir, id, { fs: options.fs })
      || '';
  }
  if (client === 'senpi') {
    for (const sessionsDir of resolveSenpiSessionsDirs({
      homeDir: home,
      env: options.env,
      useEnvRoots: options.useEnvRoots
    })) {
      const found = findTimestampedSessionFiles(sessionsDir, [id]).get(id);
      if (found) return found;
    }
    return '';
  }
  return '';
}

module.exports = { findSessionFiles, findTimestampedSessionFiles, findCodexSessionFiles, preferredCodexSessionFile, codexSessionFile, resolveSessionFile, isSafeSessionId };
