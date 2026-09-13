// Explicit opt-in entry point: default CI/demo remains synthetic.
process.env.POD_DEMO_AI = "codex";
require("./demo-authority");
