import fs from "node:fs";
import path from "node:path";
import { collectSourceEvidence, sourceEvidenceHash } from "./source-review";
import { sealDelivery } from "./delivery";

/** Prepare on the source owner's host. Publish delivery.json and commitments.json, keep delivery.key private. */
export function runDeliveryCli(args: string[]): Record<string, unknown> {
  const usage="delivery seal --source <candidate-directory> --output-dir <new-directory>";
  if (args.length!==5 || args[0]!=="seal") throw new Error(usage);
  const flags:Record<string,string>={};
  for(let i=1;i<args.length;i+=2){
    if (!["--source","--output-dir"].includes(args[i]) || flags[args[i]] || !args[i+1] || args[i+1].startsWith("--")) throw new Error(usage);
    flags[args[i]]=args[i+1];
  }
  if(!flags["--source"] || !flags["--output-dir"]) throw new Error(usage);
  const source=collectSourceEvidence(path.resolve(flags["--source"]));
  const delivery=sealDelivery(Buffer.from(JSON.stringify(source)));
  const output=path.resolve(flags["--output-dir"]);
  // Exclusive new directory. Never remove a user's previous delivery or silently overwrite its key.
  fs.mkdirSync(output,{mode:0o700});
  const commitments={version:1,sourceHash:sourceEvidenceHash(source),sourcePackageHash:delivery.packageHash,sourceKeyHash:delivery.keyHash};
  fs.writeFileSync(path.join(output,"delivery.key"),delivery.key+"\n",{flag:"wx",mode:0o600});
  fs.writeFileSync(path.join(output,"delivery.json"),JSON.stringify(delivery.envelope,null,2)+"\n",{flag:"wx",mode:0o600});
  fs.writeFileSync(path.join(output,"commitments.json"),JSON.stringify(commitments,null,2)+"\n",{flag:"wx",mode:0o600});
  return {...commitments,outputDirectory:output,keyFile:path.join(output,"delivery.key")};
}
if(require.main===module){
  try {console.log(JSON.stringify(runDeliveryCli(process.argv.slice(2)),null,2));}
  catch {console.error("Delivery preparation failed. Check source bounds and use a new output directory. Keep delivery.key private until atomic handover.");process.exitCode=1;}
}
