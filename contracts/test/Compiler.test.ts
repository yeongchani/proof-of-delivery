import { expect } from "chai";
import { run } from "hardhat";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import { CompilerDownloader } from "hardhat/internal/solidity/compiler/downloader";

describe("Reproducible compiler setup", () => {
  it("uses installed Solidity 0.8.24 even when compiler downloads are unavailable", async () => {
    const original = CompilerDownloader.prototype.downloadCompiler;
    CompilerDownloader.prototype.downloadCompiler = async () => {
      throw new Error("compiler download unavailable (regression guard)");
    };
    try {
      const build = await run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { solcVersion: "0.8.24", quiet: true });
      expect(build.isSolcJs).to.equal(true);
      expect(build.version).to.equal("0.8.24");
      expect(build.longVersion).to.match(/^0\.8\.24\+commit\.e11b9ed9/);
      expect(build.compilerPath).to.equal(require.resolve("solc/soljson.js"));
    } finally {
      CompilerDownloader.prototype.downloadCompiler = original;
    }
  });
});
