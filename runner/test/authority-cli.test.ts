import { describe, expect, it } from "vitest";
import { parseAuthorityArgs, runAuthorityCli } from "../src/authority-cli";
import { authorityDeploymentConfig } from "../../contracts/scripts/deploy-authority";
import { Wallet } from "ethers";

const target = ["--chain-id", "31337", "--escrow", "0x1111111111111111111111111111111111111111"];
describe("authority command boundaries", () => {
  it("defaults lifecycle calls to simulation and requires explicit send", () => {
    expect(parseAuthorityArgs(["call", ...target, "--method", "fund", "--args", "args.json", "--from", "0x2222222222222222222222222222222222222222"]).send).toBe(false);
    expect(parseAuthorityArgs(["call", ...target, "--method", "fund", "--args", "args.json", "--send"]).send).toBe(true);
  });
  it.each([
    [], ["sign"], ["submit", ...target],
    ["call", ...target, "--method", "fund", "--args", "a", "--send", "--send"],
    ["call", ...target, "--method", "fund", "--args", "a", "--private-key", "secret"],
    ["call", ...target, "--method", "fund", "--args", "a", "--chain-id", "1"],
    ["call", ...target, "--method", "submitResult", "--args", "a"],
  ].map(args => ({args})))("rejects incomplete, duplicate, unknown, or bypassing arguments: $args", ({args}) => {
    expect(() => parseAuthorityArgs(args)).toThrow();
  });
  it("fails on missing RPC instead of successfully skipping", async () => {
    await expect(runAuthorityCli(["call", ...target, "--method", "getAgreement", "--args", "not-read.json"], {})).rejects.toThrow("RPC_URL");
  });
  it("requires a neutral explicit arbiter and explicit deployment send", () => {
    const deployer = Wallet.createRandom();
    const config = {DEPLOYER_PRIVATE_KEY:deployer.privateKey,CHAIN_ID:"31337",ARBITER_ADDRESS:Wallet.createRandom().address,AUTHORITY_DEPLOYMENT_FILE:"deployment.json"};
    expect(authorityDeploymentConfig(config).send).toBe(false);
    expect(authorityDeploymentConfig({...config,DEPLOY_AUTHORITY_SEND:"1",USE_MOCK_TOKEN:"1"}).useMockToken).toBe(true);
    expect(() => authorityDeploymentConfig({...config,ARBITER_ADDRESS:undefined})).toThrow("ARBITER_ADDRESS");
    expect(() => authorityDeploymentConfig({...config,ARBITER_ADDRESS:deployer.address})).toThrow("neutral");
    expect(() => authorityDeploymentConfig({...config,USE_MOCK_TOKEN:"true"})).toThrow();
    expect(() => authorityDeploymentConfig({...config,USE_MOCK_TOKEN:"1",TOKEN_ADDRESS:config.ARBITER_ADDRESS})).toThrow();
  });
});
