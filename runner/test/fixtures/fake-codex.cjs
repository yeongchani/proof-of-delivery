// Subprocess contract test only. Never invokes a model.
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.154.0-alpha.6.2");
  process.exit(0);
}
const mode = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (s) => (input += s));
process.stdin.on("end", () => {
  const emit = (x) => console.log(JSON.stringify(x));
  if (mode === "tree") {
    const child = require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit",windowsHide:true});
    fs.writeFileSync("worker.pid",String(child.pid));
    setInterval(()=>{},1000); return;
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "large") {
    process.stdout.write("x".repeat(2200000));
    return;
  }
  if (mode === "exit") {
    console.error("secret-error-body");
    process.exit(7);
  }
  if (mode === "invalid") {
    console.log("bad-json");
    return;
  }
  emit({ type: "thread.started", thread_id: "test" });
  emit({ type: "turn.started" });
  if (mode === "tool") {
    emit({
      type: "item.started",
      item: { type: "command_execution", command: "unwanted" },
    });
    setInterval(() => {}, 1000);
    return;
  }
  const flag = process.argv.find((x) =>
    x.startsWith("model_instructions_file=")
  );
  const system = fs.readFileSync(
    JSON.parse(flag.slice(flag.indexOf("=") + 1)),
    "utf8"
  );
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        input,
        system,
        env: process.env,
        cwd: process.cwd(),
      }),
    },
  });
  if (mode === "incomplete") return;
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      output_tokens: mode === "tokens" ? 101 : 4,
      cached_input_tokens: 2,
    },
  });
});
