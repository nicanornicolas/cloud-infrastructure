"use strict";

// Structured logs: Cloud Logging parses one JSON object per line and maps `severity`/`message`.
function log(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, ...fields });
  if (severity === "ERROR" || severity === "WARNING") console.error(line);
  else console.log(line);
}

module.exports = { log };
