import { readGraphPackage } from "@morivyx/kernel";
import { validatePackage } from "@morivyx/kernel/validator";

if (process.argv.length !== 3) {
  console.error("Usage: node read-package.mjs <package-directory>");
  process.exit(1);
}
const directory = process.argv[2];
const validation = await validatePackage(directory);
if (!validation.valid) {
  console.error(JSON.stringify({ valid: false, issues: validation.issues }, null, 2));
  process.exit(1);
}
const contents = await readGraphPackage(directory);
console.log(JSON.stringify({
  valid: true,
  graphRevision: contents.revision.id,
  rootDigest: contents.calculatedRootDigest,
  schemaLockDigest: contents.calculatedSchemaLockDigest,
  elements: contents.elements.map(({ id, type, lifecycle, reviewState, attributes }) =>
    ({ id, type, lifecycle, reviewState, attributes })),
}, null, 2));
