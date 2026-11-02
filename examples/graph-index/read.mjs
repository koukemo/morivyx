import { buildGraphIndex, graphIndexSnapshot } from "../../packages/kernel/src/graph-index.js";
import { readGraphPackage } from "../../packages/kernel/src/package-reader.js";

if (process.argv.length !== 5) {
  console.error("Usage: node examples/graph-index/read.mjs <package> <type> <element-id>");
  process.exit(1);
}
const [path, type, focusId] = process.argv.slice(2);
const contents = await readGraphPackage(path);
// Always derive from the checked source; do not trust cached element bodies.
const index = buildGraphIndex({ graphRevision: contents.revision.id, elements: contents.elements });
console.log(JSON.stringify({ valid: true, index: graphIndexSnapshot(index), query: {
  type, focusId, focusExists: index.byId.has(focusId),
  elementIds: index.byType.get(type) ?? [],
  outgoingRelationIds: index.outgoing.get(focusId) ?? [],
  incomingRelationIds: index.incoming.get(focusId) ?? [],
} }, null, 2));
