import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { canonicalHash } from "../src/hash";
import {
  approvedPolicySuiteHash,
  loadApprovedPolicy,
} from "../src/approved-policy";
import { runAcceptance } from "../src/run-tests";
import { spawnSync } from "child_process";

const dirs: string[] = [];
function setup() {
  const root = fs.mkdtempSync(
    path.resolve(__dirname, "../../.pod-policy-test-")
  );
  dirs.push(root);
  const directory = path.join(root, "approved"),
    candidate = path.join(root, "candidate");
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(candidate, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "vitest.config.ts"),
    `import {defineConfig} from 'vitest/config'; import path from 'path'; export default defineConfig({resolve:{alias:{'pod-deliverable':path.join(process.env.POD_DELIVERABLE_DIR!,'src/app.ts')}},test:{root:__dirname,include:['double.test.ts'],pool:'forks',maxWorkers:1,minWorkers:1}});`
  );
  fs.writeFileSync(
    path.join(directory, "expected.ts"),
    "export const expected = 42;"
  );
  fs.writeFileSync(
    path.join(directory, "double.test.ts"),
    "import {it,expect} from 'vitest'; import {double} from 'pod-deliverable'; import {expected} from './expected'; it('doubles input',()=>expect(double(21)).toBe(expected));"
  );
  const expectedSuiteHash = approvedPolicySuiteHash(directory);
  const acceptance = {
    version: "1",
    agreement: "different job",
    milestone: 0,
    trigger: "all_tier1_pass",
    testSuiteHash: expectedSuiteHash,
    criteria: [
      {
        id: "DOUBLE",
        desc: "Doubles a number",
        test: "doubles input",
        tier: 1,
      },
    ],
  };
  fs.writeFileSync(
    path.join(directory, "acceptance.json"),
    JSON.stringify(acceptance)
  );
  fs.writeFileSync(
    path.join(candidate, "acceptance.json"),
    JSON.stringify(acceptance)
  );
  fs.writeFileSync(
    path.join(candidate, "src/app.ts"),
    "export const double=(n:number)=>n*2;"
  );
  fs.writeFileSync(
    path.join(candidate, "vitest.config.ts"),
    "throw new Error('candidate config ran');"
  );
  return {
    candidate,
    directory,
    approval: {
      directory,
      expectedSuiteHash,
      expectedAcceptanceHash: canonicalHash(acceptance),
    },
  };
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
);
describe("independently approved policy bundles", () => {
  it("executes the generic CLI options file and exports source-bound AI input", () => {
    const f = setup();
    const root = path.dirname(f.directory),
      outDir = path.join(root, "out");
    const optionsFile = path.join(root, "options.json");
    fs.writeFileSync(
      optionsFile,
      JSON.stringify({
        deliverableDir: f.candidate,
        approvedPolicy: f.approval,
        outDir,
        agreementId: 7,
        quiet: true,
      })
    );
    const repo = path.resolve(__dirname, "../..");
    const proc = spawnSync(
      process.execPath,
      [
        "-r",
        path.join(repo, "node_modules/ts-node/register/transpile-only"),
        path.join(repo, "runner/src/run-tests.ts"),
        "--options",
        optionsFile,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.join(repo, "runner/tsconfig.json"),
        },
      }
    );
    expect(proc.status, proc.stderr).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8"))
        .agreementId
    ).toBe(7);
    const input = JSON.parse(
      fs.readFileSync(path.join(outDir, "review-input.json"), "utf8")
    );
    expect(input.criteria[0].id).toBe("DOUBLE");
    expect(
      input.evidence.some(
        (e: { text: string }) =>
          e.text.includes("src/app.ts") && e.text.includes("n*2")
      )
    ).toBe(true);
  }, 30000);
  it("runs a different approved acceptance suite without candidate configuration", () => {
    const f = setup();
    const result = runAcceptance({
      deliverableDir: f.candidate,
      approvedPolicy: f.approval,
      outDir: null,
      quiet: true,
    });
    expect(result.passed).toBe(true);
    expect(result.criteria.map((c) => c.id)).toEqual(["DOUBLE"]);
    expect(
      result.sourceEvidence?.files.some((f) => f.content.includes("n*2"))
    ).toBe(true);
  }, 30000);
  it("rejects changes to a helper in the executable bundle", () => {
    const f = setup();
    fs.appendFileSync(path.join(f.directory, "expected.ts"), "\n// changed");
    expect(() => loadApprovedPolicy(f.approval, f.candidate)).toThrow(
      /suite|policy/i
    );
  });
  it("rejects unapproved acceptance and candidate-owned bundles", () => {
    const f = setup();
    expect(() =>
      loadApprovedPolicy(
        { ...f.approval, expectedAcceptanceHash: "0x" + "0".repeat(64) },
        f.candidate
      )
    ).toThrow();
    expect(() =>
      loadApprovedPolicy({ ...f.approval, directory: f.candidate }, f.candidate)
    ).toThrow();
  });
  it("rejects candidate filesystem mutation before executing it", () => {
    const f = setup();
    fs.writeFileSync(
      path.join(f.candidate, "src/app.ts"),
      `import fs from 'fs'; import path from 'path'; export const double=(n:number)=>{fs.appendFileSync(path.join(process.env.POD_DELIVERABLE_DIR!,'src/app.ts'),'\\n// changed during execution');return n*2;};`
    );
    expect(() =>
      runAcceptance({
        deliverableDir: f.candidate,
        approvedPolicy: f.approval,
        outDir: null,
        quiet: true,
      })
    ).toThrow(/unsupported dependency.*fs/i);
  }, 30000);
  it("rejects candidate policy mutation before executing it", () => {
    const f = setup();
    fs.writeFileSync(
      path.join(f.candidate, "src/app.ts"),
      `import fs from 'fs'; export const double=(n:number)=>{fs.appendFileSync(${JSON.stringify(
        path.join(f.directory, "expected.ts")
      )},'\\n// changed during execution');return n*2;};`
    );
    expect(() =>
      runAcceptance({
        deliverableDir: f.candidate,
        approvedPolicy: f.approval,
        outDir: null,
        quiet: true,
      })
    ).toThrow(/unsupported dependency.*fs/i);
  }, 30000);
  it("does not allow an executable import outside the approved bundle", () => {
    const f = setup();
    fs.appendFileSync(
      path.join(f.directory, "expected.ts"),
      "\nimport '../unapproved.ts';"
    );
    expect(() => approvedPolicySuiteHash(f.directory)).toThrow(
      /outside|import/i
    );
  });
  it("still detects a trusted policy test mutating its approved helper", () => {
    const f=setup();
    fs.appendFileSync(path.join(f.directory,"double.test.ts"),
      `\nimport fs from 'fs'; fs.appendFileSync(${JSON.stringify(path.join(f.directory,"expected.ts"))},'\\n// changed');`);
    const acceptance=JSON.parse(fs.readFileSync(path.join(f.directory,"acceptance.json"),"utf8"));
    acceptance.testSuiteHash=approvedPolicySuiteHash(f.directory);
    fs.writeFileSync(path.join(f.directory,"acceptance.json"),JSON.stringify(acceptance));
    fs.writeFileSync(path.join(f.candidate,"acceptance.json"),JSON.stringify(acceptance));
    expect(()=>runAcceptance({deliverableDir:f.candidate,outDir:null,quiet:true,approvedPolicy:{...f.approval,
      expectedSuiteHash:acceptance.testSuiteHash,expectedAcceptanceHash:canonicalHash(acceptance)}})).toThrow(/policy/i);
  },30000);
});
