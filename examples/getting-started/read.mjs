import { readGraphPackage } from "../../packages/kernel/src/package-reader.js";

if (process.argv.length !== 3) {
  console.error("Usage: node examples/getting-started/read.mjs <package-directory>");
  process.exit(1);
}
const contents = await readGraphPackage(process.argv[2]);
console.log(JSON.stringify({
  revision: contents.revision.id,
  elements: contents.elements.map(({ id, type, lifecycle, reviewState, attributes }) =>
    ({ id, type, lifecycle, reviewState, attributes })),
}, null, 2));
