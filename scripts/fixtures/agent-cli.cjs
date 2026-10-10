const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const args = process.argv.slice(2),
  resumed = args[0] === "resume",
  id = resumed ? args[1] : crypto.randomUUID(),
  file = path.join(process.env.KAIRO_FIXTURE_HISTORY, id + ".json");
const record = resumed
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { id, cwd: process.cwd(), prompts: [], resumes: 0, createdAt: Date.now() };
if (record.cwd !== process.cwd()) throw new Error("Wrong resume workspace");
if (resumed) record.resumes++;
const save = () => fs.writeFileSync(file, JSON.stringify(record));
save();
if (process.env.KAIRO_FIXTURE_NATIVE_HOME) {
  const folder = path.join(
    process.env.KAIRO_FIXTURE_NATIVE_HOME,
    "sessions",
    ...new Date(record.createdAt).toISOString().slice(0, 10).split("-"),
  );
  fs.mkdirSync(folder, { recursive: true });
  const rollout = path.join(folder, `rollout-${record.id}.jsonl`);
  if (!fs.existsSync(rollout))
    fs.writeFileSync(
      rollout,
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date(record.createdAt).toISOString(),
        payload: { id: record.id, cwd: record.cwd, source: "cli" },
      }) + "\n",
    );
  fs.utimesSync(rollout, new Date(), new Date());
}
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
