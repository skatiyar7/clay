var fs = require("fs");
var path = require("path");
var readline = require("readline");
var utils = require("./utils");
var { REAL_HOME } = require("./config");

var encodeCwd = utils.encodeCwd;

/**
 * Parse the first ~20 lines of a CLI session JSONL file to extract metadata.
 * Returns null if the file can't be parsed or has no user messages.
 */
function parseSessionFile(filePath, maxLines) {
  if (maxLines == null) maxLines = 20;
  return new Promise(function (resolve) {
    var sessionId = path.basename(filePath, ".jsonl");
    var result = {
      sessionId: sessionId,
      firstPrompt: "",
      model: null,
      gitBranch: null,
      startTime: null,
      lastActivity: null,
    };

    var lineCount = 0;
    var foundUser = false;
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve(null);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", function (line) {
      lineCount++;
      if (lineCount > maxLines) {
        rl.close();
        stream.destroy();
        return;
      }

      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }

      // Skip file-history-snapshot, queue-operation, and other non-message records
      if (obj.type === "user" && obj.message && obj.message.role === "user") {
        if (!foundUser) {
          foundUser = true;
          result.sessionId = obj.sessionId || sessionId;
          result.gitBranch = obj.gitBranch || null;
          if (obj.timestamp) result.startTime = obj.timestamp;
          var content = obj.message.content || "";
          if (typeof content === "string") {
            result.firstPrompt = content.substring(0, 100);
          } else if (Array.isArray(content)) {
            for (var i = 0; i < content.length; i++) {
              if (content[i].type === "text" && content[i].text) {
                result.firstPrompt = content[i].text.substring(0, 100);
                break;
              }
            }
          }
        }
        // Track latest user timestamp for lastActivity
        if (obj.timestamp) result.lastActivity = obj.timestamp;
      }

      // Extract model from first assistant message
      if (!result.model && obj.message && obj.message.role === "assistant" && obj.message.model) {
        result.model = obj.message.model;
      }
    });

    rl.on("close", function () {
      if (!foundUser) return resolve(null);

      // Use file mtime as fallback for lastActivity, or as a better proxy
      // since we only read the first ~20 lines
      try {
        var stat = fs.statSync(filePath);
        var mtime = stat.mtime.toISOString();
        // File mtime is always more accurate for "last activity" since we
        // don't read the entire file
        result.lastActivity = mtime;
      } catch (e) {}

      resolve(result);
    });

    rl.on("error", function () {
      resolve(null);
    });

    stream.on("error", function () {
      rl.close();
      resolve(null);
    });
  });
}

/**
 * List CLI sessions for a given project directory.
 * Reads ~/.claude/projects/{encoded-cwd}/ and parses JSONL metadata.
 * Returns array sorted by lastActivity descending (most recent first).
 */
function listCliSessions(cwd) {
  var encoded = encodeCwd(cwd);
  var projectDir = path.join(REAL_HOME, ".claude", "projects", encoded);

  return new Promise(function (resolve) {
    fs.readdir(projectDir, { withFileTypes: true }, function (err, entries) {
      if (err) return resolve([]);

      var jsonlFiles = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isFile() && entries[i].name.endsWith(".jsonl")) {
          jsonlFiles.push(path.join(projectDir, entries[i].name));
        }
      }

      if (jsonlFiles.length === 0) return resolve([]);

      var pending = jsonlFiles.length;
      var results = [];

      for (var j = 0; j < jsonlFiles.length; j++) {
        parseSessionFile(jsonlFiles[j]).then(function (session) {
          if (session) results.push(session);
          pending--;
          if (pending === 0) {
            results.sort(function (a, b) {
              var ta = a.lastActivity || "";
              var tb = b.lastActivity || "";
              return ta < tb ? 1 : ta > tb ? -1 : 0;
            });
            resolve(results);
          }
        });
      }
    });
  });
}

/**
 * Get the most recent CLI session for a given project directory.
 * Returns the session object or null if none found.
 */
function getMostRecentCliSession(cwd) {
  return listCliSessions(cwd).then(function (sessions) {
    return sessions.length > 0 ? sessions[0] : null;
  });
}

/**
 * Extract user message text from a CLI JSONL content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === "text" && content[i].text) {
      parts.push(content[i].text);
    }
  }
  return parts.join("");
}

/**
 * Convert a single parsed CLI JSONL record into relay-compatible history
 * entries (user_message, delta, tool_start, tool_executing, tool_result).
 * `state` carries a mutable toolCounter across records so tool IDs stay
 * unique within one conversion pass. Returns an array (possibly empty).
 */
function convertRecordToHistory(obj, state) {
  var out = [];
  if (!obj || !obj.message) return out;

  // User prompt
  if (obj.type === "user" && obj.message.role === "user") {
    // Skip tool_result records (they have type "user" but content is tool results)
    var content = obj.message.content;
    if (Array.isArray(content) && content.length > 0 && content[0].type === "tool_result") {
      return out;
    }
    var text = extractText(content);
    if (text) {
      out.push({ type: "user_message", text: text });
    }
    return out;
  }

  // Assistant message
  if (obj.message.role === "assistant" && Array.isArray(obj.message.content)) {
    for (var i = 0; i < obj.message.content.length; i++) {
      var block = obj.message.content[i];

      if (block.type === "text" && block.text) {
        out.push({ type: "delta", text: block.text });
      }

      if (block.type === "tool_use") {
        var toolId = "cli-tool-" + (++state.toolCounter);
        var toolName = block.name || "Tool";
        out.push({ type: "tool_start", id: toolId, name: toolName });
        out.push({
          type: "tool_executing",
          id: toolId,
          name: toolName,
          input: block.input || {},
        });
        // Emit ask_user_answered so the client re-enables input after replaying AskUserQuestion
        if (toolName === "AskUserQuestion") {
          out.push({ type: "ask_user_answered", toolId: toolId });
        }
        out.push({ type: "tool_result", id: toolId, content: "" });
      }
    }
  }
  return out;
}

/**
 * Read a full CLI session JSONL file and convert it to relay-compatible
 * history entries (user_message, delta, tool_start, tool_executing, tool_result).
 * Returns a Promise that resolves to an array of history entries.
 */
function readCliSessionHistory(cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var filePath = path.join(REAL_HOME, ".claude", "projects", encoded, sessionId + ".jsonl");

  return new Promise(function (resolve) {
    var history = [];
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve([]);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    var state = { toolCounter: 0 };

    rl.on("line", function (line) {
      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }
      var entries = convertRecordToHistory(obj, state);
      for (var i = 0; i < entries.length; i++) history.push(entries[i]);
    });

    rl.on("close", function () {
      resolve(history);
    });

    rl.on("error", function () {
      resolve([]);
    });

    stream.on("error", function () {
      rl.close();
      resolve([]);
    });
  });
}

/**
 * Absolute path of a CLI session JSONL file for a given project cwd.
 */
function cliSessionFilePath(cwd, sessionId) {
  return path.join(REAL_HOME, ".claude", "projects", encodeCwd(cwd), sessionId + ".jsonl");
}

/**
 * Directory containing CLI session JSONL files for a given project cwd.
 */
function cliProjectDir(cwd) {
  return path.join(REAL_HOME, ".claude", "projects", encodeCwd(cwd));
}

module.exports = {
  listCliSessions: listCliSessions,
  convertRecordToHistory: convertRecordToHistory,
  cliSessionFilePath: cliSessionFilePath,
  cliProjectDir: cliProjectDir,
  getMostRecentCliSession: getMostRecentCliSession,
  readCliSessionHistory: readCliSessionHistory,
  parseSessionFile: parseSessionFile,
  encodeCwd: encodeCwd,
  extractText: extractText,
};
