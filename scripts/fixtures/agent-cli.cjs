const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const args = process.argv.slice(2),
  resumed = args[0] === "resume",
  id = resumed ? args[1] : crypto.randomUUID(),
  file = path.join(process.env.KAIRO_FIXTURE_HISTORY, id + ".json");
const record = resumed
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { id, cwd: process.cwd(), prompts: [], resumes: 0 };
if (record.cwd !== process.cwd()) throw new Error("Wrong resume workspace");
if (resumed) record.resumes++;
const save = () => fs.writeFileSync(file, JSON.stringify(record));
save();
console.log("\x1b[32mCLI_READY\x1b[0m NATIVE_ID:" + id);
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    try {
      const input = JSON.parse(line);
      record.prompts.push(line);
      fs.writeFileSync(input.file, input.content);
      save();
      console.log("SAVED:" + input.file);
    } catch {
      console.log("Use a fixture JSON command");
    }
  });
setInterval(() => {}, 1000);
