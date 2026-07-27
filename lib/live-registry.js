var fs = require("fs");
var path = require("path");
var { REAL_HOME } = require("./config");

// Claude Code's live session registry: one JSON file per running CLI process
// ({pid, sessionId, cwd, name, kind}). Entries whose PID is dead are stale.
var REGISTRY_DIR = path.join(REAL_HOME, ".claude", "sessions");

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Read Claude Code's registry of currently running CLI processes.
 * Filters to entries whose PID is alive. When cwd is given, only entries for
 * that working directory are returned. Returns null when the registry
 * directory doesn't exist (older CLI versions — caller should fall back).
 */
function readLiveRegistry(cwd) {
  var names;
  try {
    names = fs.readdirSync(REGISTRY_DIR);
  } catch (e) {
    return null;
  }
  var entries = [];
  for (var i = 0; i < names.length; i++) {
    if (!names[i].endsWith(".json")) continue;
    var entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, names[i]), "utf8"));
    } catch (e) {
      continue;
    }
    if (!entry || !entry.sessionId) continue;
    if (cwd && entry.cwd !== cwd) continue;
    if (!isPidAlive(entry.pid)) continue;
    entries.push(entry);
  }
  return entries;
}

module.exports = {
  REGISTRY_DIR: REGISTRY_DIR,
  isPidAlive: isPidAlive,
  readLiveRegistry: readLiveRegistry,
};
