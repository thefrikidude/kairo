// Fixture agent for verification. Installed as `codex` and `claude` in a throwaway PATH.
//   codex  prints continuously, so Kairo always sees it as working.
//   claude stays quiet until asked, then announces work and writes its file while that output is
//          still fresh, so it only counts as working for a moment.
// Both accept one JSON line on stdin: {"file": "<relative path>", "content": "<text>"}.
const fs = require("node:fs");
const path = require("node:path");

const name = path.basename(process.argv[1]);
const ticker = name === "codex";
console.log("E2E_READY " + name);
if (ticker) setInterval(() => console.log("tick"), 80);
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    try {
      const request = JSON.parse(line);
      const write = () => fs.writeFileSync(request.file, request.content);
      if (ticker) write();
      else {
        setTimeout(() => console.log("busy"), 500);
        setTimeout(write, 650);
      }
    } catch {
      // Not a command; the real agents ignore stray input too.
    }
  });
setInterval(() => {}, 1000);
