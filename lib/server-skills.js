// External skills fetching (skills.sh) is disabled.
// Only the attachSkills stub remains so server.js doesn't break.

function attachSkills() {
  return {
    handleRequest: function () { return false; },
  };
}

module.exports = { attachSkills: attachSkills };
