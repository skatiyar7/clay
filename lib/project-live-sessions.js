var fs = require("fs");
var path = require("path");
var cliSessions = require("./cli-sessions");
var { REGISTRY_DIR, readLiveRegistry } = require("./live-registry");

// Fallback liveness window (registry absent, e.g. older CLI versions): a CLI
// session file counts as "live" when modified within this window.
var LIVE_WINDOW_MS = 5 * 60 * 1000;
// Fallback rescan interval when fs.watch misses events (network mounts, etc.)
var RESCAN_INTERVAL_MS = 15 * 1000;
// Debounce for tail reads after a change event
var TAIL_DEBOUNCE_MS = 150;

/**
 * Live CLI session engine.
 *
 * Detects Claude CLI sessions that are actively running in a terminal on the
 * host (by watching ~/.claude/projects/{encoded-cwd}/ for recently modified
 * JSONL files that Clay does not own) and:
 *
 *   1. Broadcasts a `live_cli_sessions` list so the browser can show them.
 *   2. Tails the JSONL file of a live session after the user attaches to it,
 *      streaming new turns into the Clay session in real time (live mirror).
 *
 * Taking over (sending a message from the browser) stops the tail — the
 * session then behaves like any resumed session.
 *
 * ctx fields: cwd, sm, send
 */
function attachLiveSessions(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var send = ctx.send;

  var projectDir = cliSessions.cliProjectDir(cwd);
  var dirWatcher = null;
  var registryWatcher = null;
  var rescanTimer = null;
  var scanDebounce = null;
  var lastBroadcastJson = "";
  var tails = {}; // cliSessionId -> { watcher, offset, buffer, debounce, session, pollTimer }

  // --- Liveness detection ---

  function isClayOwned(cliSessionId) {
    var owned = false;
    sm.sessions.forEach(function (s) {
      if (s.cliSessionId === cliSessionId) owned = true;
    });
    if (owned) return true;
    try {
      return fs.existsSync(path.join(sm.sessionsDir, cliSessionId + ".jsonl"));
    } catch (e) {
      return false;
    }
  }

  function scanLiveSessions() {
    return new Promise(function (resolve) {
      // Preferred source: Claude Code's registry of running CLI processes.
      // It knows about idle sessions the mtime heuristic would miss.
      var registry = readLiveRegistry(cwd);
      var registryById = {};
      var candidates = [];

      if (registry !== null) {
        for (var r = 0; r < registry.length; r++) {
          var reg = registry[r];
          if (isClayOwned(reg.sessionId)) continue;
          var regSt;
          try { regSt = fs.statSync(path.join(projectDir, reg.sessionId + ".jsonl")); } catch (e) { continue; }
          registryById[reg.sessionId] = reg;
          candidates.push({ id: reg.sessionId, mtime: regSt.mtime });
        }
        return finishScan(candidates, registryById, resolve);
      }

      // Fallback: recent-mtime heuristic over the project transcript dir.
      fs.readdir(projectDir, function (err, names) {
        if (err) return resolve([]);
        var now = Date.now();
        for (var i = 0; i < names.length; i++) {
          if (!names[i].endsWith(".jsonl")) continue;
          var id = names[i].replace(".jsonl", "");
          var st;
          try { st = fs.statSync(path.join(projectDir, names[i])); } catch (e) { continue; }
          if (now - st.mtime.getTime() > LIVE_WINDOW_MS) continue;
          if (isClayOwned(id)) continue;
          candidates.push({ id: id, mtime: st.mtime });
        }
        finishScan(candidates, registryById, resolve);
      });
    });

    function finishScan(candidates, registryById, resolve) {
      if (candidates.length === 0) return resolve([]);
      var pending = candidates.length;
      var results = [];
      candidates.forEach(function (c) {
        cliSessions.parseSessionFile(path.join(projectDir, c.id + ".jsonl")).then(function (meta) {
          var reg = registryById[c.id];
          if (meta || reg) {
            results.push({
              sessionId: c.id,
              // Prefer the CLI's own session name (what the terminal shows)
              firstPrompt: (reg && reg.name && reg.nameSource !== "derived" ? reg.name : null)
                || (meta && meta.firstPrompt) || (reg && reg.name) || "",
              gitBranch: (meta && meta.gitBranch) || null,
              lastActivity: c.mtime.toISOString(),
              kind: (reg && reg.kind) || null,
              live: true,
            });
          }
          pending--;
          if (pending === 0) {
            results.sort(function (a, b) {
              return a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0;
            });
            resolve(results);
          }
        });
      });
    }
  }

  function broadcastLiveSessions(force) {
    scanLiveSessions().then(function (sessions) {
      var json = JSON.stringify(sessions.map(function (s) { return s.sessionId + ":" + s.lastActivity; }));
      if (!force && json === lastBroadcastJson) return;
      lastBroadcastJson = json;
      send({ type: "live_cli_sessions", sessions: sessions });
    });
  }

  function scheduleScan() {
    clearTimeout(scanDebounce);
    scanDebounce = setTimeout(function () { broadcastLiveSessions(false); }, 500);
  }

  function startWatching() {
    if (dirWatcher) return;
    try {
      dirWatcher = fs.watch(projectDir, function () { scheduleScan(); });
      dirWatcher.on("error", function () { stopWatching(); });
    } catch (e) {
      // Directory may not exist yet (no CLI sessions for this project)
    }
    // Registry watcher: react immediately when CLI processes start/stop
    if (!registryWatcher) {
      try {
        registryWatcher = fs.watch(REGISTRY_DIR, function () { scheduleScan(); });
        registryWatcher.on("error", function () {
          try { registryWatcher.close(); } catch (e) {}
          registryWatcher = null;
        });
      } catch (e) {
        // Registry dir absent (older CLI) — mtime fallback covers it
      }
    }
    if (!rescanTimer) {
      rescanTimer = setInterval(function () {
        // Also retry establishing the dir watcher if the directory appeared later
        if (!dirWatcher) startWatching();
        broadcastLiveSessions(false);
      }, RESCAN_INTERVAL_MS);
      if (rescanTimer.unref) rescanTimer.unref();
    }
  }

  function stopWatching() {
    if (dirWatcher) {
      try { dirWatcher.close(); } catch (e) {}
      dirWatcher = null;
    }
    if (registryWatcher) {
      try { registryWatcher.close(); } catch (e) {}
      registryWatcher = null;
    }
  }

  // --- Live mirror (tail) ---

  function readNewData(tail) {
    var filePath = cliSessions.cliSessionFilePath(cwd, tail.cliSessionId);
    var st;
    try { st = fs.statSync(filePath); } catch (e) { return; }
    if (st.size <= tail.offset) {
      // File truncated (compaction/rewrite): restart from the end to avoid replaying
      if (st.size < tail.offset) tail.offset = st.size;
      return;
    }
    var fd;
    try { fd = fs.openSync(filePath, "r"); } catch (e) { return; }
    var len = st.size - tail.offset;
    var buf = Buffer.alloc(len);
    var read = 0;
    try { read = fs.readSync(fd, buf, 0, len, tail.offset); } catch (e) {}
    try { fs.closeSync(fd); } catch (e) {}
    if (read <= 0) return;
    tail.offset += read;
    tail.buffer += buf.toString("utf8", 0, read);

    var lines = tail.buffer.split("\n");
    tail.buffer = lines.pop(); // keep trailing partial line
    var session = tail.session;
    var emitted = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      var entries = cliSessions.convertRecordToHistory(obj, tail.convState);
      for (var j = 0; j < entries.length; j++) {
        entries[j].liveMirror = true;
        sm.sendAndRecord(session, entries[j]);
        emitted = true;
      }
    }
    if (emitted) {
      session.lastActivity = Date.now();
      sm.broadcastSessionList();
    }
  }

  function attachTail(session) {
    if (!session || !session.cliSessionId) return false;
    if (tails[session.cliSessionId]) return true;
    var filePath = cliSessions.cliSessionFilePath(cwd, session.cliSessionId);
    var startOffset = 0;
    try { startOffset = fs.statSync(filePath).size; } catch (e) { return false; }

    var tail = {
      cliSessionId: session.cliSessionId,
      session: session,
      offset: startOffset,
      buffer: "",
      debounce: null,
      watcher: null,
      pollTimer: null,
      convState: { toolCounter: 100000 }, // avoid tool-id collisions with replayed history
    };

    function onChange() {
      clearTimeout(tail.debounce);
      tail.debounce = setTimeout(function () { readNewData(tail); }, TAIL_DEBOUNCE_MS);
    }

    try {
      tail.watcher = fs.watch(filePath, onChange);
      tail.watcher.on("error", function () { detachTail(session.cliSessionId); });
    } catch (e) {
      return false;
    }
    // Poll fallback: fs.watch can miss appends on some filesystems
    tail.pollTimer = setInterval(function () { readNewData(tail); }, 2000);
    if (tail.pollTimer.unref) tail.pollTimer.unref();

    tails[session.cliSessionId] = tail;
    session.liveMirror = true;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    sm.sendToSession(session.localId, { type: "live_mirror_state", id: session.localId, active: true });
    return true;
  }

  function detachTail(cliSessionId) {
    var tail = tails[cliSessionId];
    if (!tail) return;
    clearTimeout(tail.debounce);
    if (tail.pollTimer) clearInterval(tail.pollTimer);
    if (tail.watcher) { try { tail.watcher.close(); } catch (e) {} }
    delete tails[cliSessionId];
    if (tail.session) {
      // Flush anything already appended before detaching
      try { readNewData(tail); } catch (e) {}
      tail.session.liveMirror = false;
      sm.saveSessionFile(tail.session);
      sm.broadcastSessionList();
      sm.sendToSession(tail.session.localId, { type: "live_mirror_state", id: tail.session.localId, active: false });
    }
  }

  function detachTailForSession(session) {
    if (session && session.cliSessionId && tails[session.cliSessionId]) {
      detachTail(session.cliSessionId);
    }
  }

  // Registry entry ({pid, name, kind}) for a session that is currently open
  // in a running CLI process, or null.
  function getLiveInfo(cliSessionId) {
    var registry = readLiveRegistry(cwd);
    if (registry === null) return null;
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].sessionId === cliSessionId) return registry[i];
    }
    return null;
  }

  function isLiveCliSession(cliSessionId) {
    // Registry is authoritative when present: a session is live iff a running
    // CLI process owns it.
    var registry = readLiveRegistry(cwd);
    if (registry !== null) {
      for (var i = 0; i < registry.length; i++) {
        if (registry[i].sessionId === cliSessionId) return true;
      }
      return false;
    }
    var filePath = cliSessions.cliSessionFilePath(cwd, cliSessionId);
    try {
      var st = fs.statSync(filePath);
      return Date.now() - st.mtime.getTime() <= LIVE_WINDOW_MS;
    } catch (e) {
      return false;
    }
  }

  function handleLiveSessionsMessage(ws, msg) {
    if (msg.type === "list_live_cli_sessions") {
      broadcastLiveSessions(true);
      return true;
    }
    if (msg.type === "live_mirror_detach") {
      var session = sm.sessions.get(msg.id);
      if (session) detachTailForSession(session);
      return true;
    }
    return false;
  }

  function cleanup() {
    stopWatching();
    clearInterval(rescanTimer);
    rescanTimer = null;
    clearTimeout(scanDebounce);
    var ids = Object.keys(tails);
    for (var i = 0; i < ids.length; i++) detachTail(ids[i]);
  }

  startWatching();

  return {
    handleLiveSessionsMessage: handleLiveSessionsMessage,
    attachTail: attachTail,
    detachTailForSession: detachTailForSession,
    isLiveCliSession: isLiveCliSession,
    getLiveInfo: getLiveInfo,
    broadcastLiveSessions: broadcastLiveSessions,
    cleanup: cleanup,
  };
}

module.exports = { attachLiveSessions: attachLiveSessions };
