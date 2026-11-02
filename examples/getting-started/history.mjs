import { readGraphPackage } from "../../packages/kernel/src/package-reader.js";

if (process.argv.length !== 3) {
  console.error("Usage: node examples/getting-started/history.mjs <package-directory>");
  process.exit(1);
}
const contents = await readGraphPackage(process.argv[2]);
// Stored records are not a claim that every ancestor snapshot is present.
console.log(JSON.stringify({
  graphRevision: contents.revision.id,
  parentRevision: contents.revision.parentRevision,
  changeSets: contents.changeSets.map(({ id, baseRevision, resultingRevision, operations }) =>
    ({ id, baseRevision, resultingRevision, operations })),
}, null, 2));
