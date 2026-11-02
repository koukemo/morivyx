import {
  canonicalJson,
  compareUnicode,
  graphRootDigest,
  revisionId,
} from "./canonical.js";
import { PackageError } from "./errors.js";
import { validateGraphElement } from "./graph-element.js";
import { readGraphPackage } from "./package-reader.js";

const GRAPH_REVISION_PATTERN = /^graph:\S+$/;
const STABLE_ID_PATTERN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sourceInvalid(path, message) {
  throw new PackageError("INDEX_SOURCE_INVALID", path, message);
}

function append(index, key, value) {
  const normalizedKey = key.normalize("NFC");
  const values = index.get(normalizedKey) ?? [];
  values.push(value.normalize("NFC"));
  index.set(normalizedKey, values);
}

function sortLists(index) {
  for (const [key, values] of index) {
    index.set(key, [...new Set(values)].sort(compareUnicode));
  }
  return new Map([...index].sort(([left], [right]) => compareUnicode(left, right)));
}

export function buildGraphIndex(input) {
  const { graphRevision, elements } = input ?? {};
  if (
    typeof graphRevision !== "string" ||
    !GRAPH_REVISION_PATTERN.test(graphRevision)
  ) {
    sourceInvalid("/graphRevision", "GraphRevision IDが不正です。");
  }
  if (!Array.isArray(elements)) {
    sourceInvalid("/elements", "GraphElementの一覧が必要です。");
  }

  elements.forEach((element, index) => {
    try {
      validateGraphElement(element);
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      sourceInvalid(`/elements/${index}${error.path}`, error.message);
    }
    let calculatedRevision;
    try {
      calculatedRevision = revisionId(element);
    } catch (error) {
      sourceInvalid(
        `/elements/${index}`,
        `GraphElementをcanonical化できません: ${error.message}`,
      );
    }
    if (element.revision !== calculatedRevision) {
      sourceInvalid(
        `/elements/${index}/revision`,
        "記録したRevision IDがcanonical再計算値と一致しません。",
      );
    }
  });

  const byId = new Map();
  const byType = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const ordered = elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) =>
      compareUnicode(
        String(left.element?.id ?? ""),
        String(right.element?.id ?? ""),
      ),
    );

  ordered.forEach(({ element, index }) => {
    const id = element.id.normalize("NFC");
    if (byId.has(id)) {
      sourceInvalid(`/elements/${index}/id`, "stable IDが重複しています。");
    }
    byId.set(id, structuredClone(element));
    append(byType, element.type, id);
  });

  ordered.forEach(({ element, index }) => {
    if (element.kind === "relation") {
      for (const field of ["source", "target"]) {
        const endpoint = element.attributes[field];
        if (
          typeof endpoint !== "string" ||
          !STABLE_ID_PATTERN.test(endpoint) ||
          !byId.has(endpoint.normalize("NFC"))
        ) {
          sourceInvalid(
            `/elements/${index}/attributes/${field}`,
            "Relationの接続先が生成元Graphにありません。",
          );
        }
      }
      append(outgoing, element.attributes.source, element.id);
      append(incoming, element.attributes.target, element.id);
    }
  });

  return {
    graphRevision: graphRevision.normalize("NFC"),
    rootDigest: graphRootDigest(ordered.map(({ element }) => element)),
    byId,
    byType: sortLists(byType),
    outgoing: sortLists(outgoing),
    incoming: sortLists(incoming),
  };
}

function listSnapshot(index, keyName) {
  return [...index].map(([key, relationIds]) => ({
    [keyName]: key,
    relationIds: [...relationIds],
  }));
}

export function graphIndexSnapshot(index) {
  return {
    graphRevision: index.graphRevision,
    rootDigest: index.rootDigest,
    elements: [...index.byId].map(([id, element]) => ({
      id,
      kind: element.kind,
      type: element.type,
      revision: element.revision,
    })),
    types: [...index.byType].map(([type, elementIds]) => ({
      type,
      elementIds: [...elementIds],
    })),
    outgoing: listSnapshot(index.outgoing, "sourceId"),
    incoming: listSnapshot(index.incoming, "targetId"),
  };
}

export function verifyGraphIndex(index, source) {
  const expected = buildGraphIndex(source);
  try {
    return {
      valid:
        canonicalJson(graphIndexSnapshot(index)) ===
        canonicalJson(graphIndexSnapshot(expected)),
      graphRevision: expected.graphRevision,
      rootDigest: expected.rootDigest,
    };
  } catch {
    return {
      valid: false,
      graphRevision: expected.graphRevision,
      rootDigest: expected.rootDigest,
    };
  }
}

export async function rebuildPackageIndex(path) {
  const packageContents = await readGraphPackage(path);
  const index = buildGraphIndex({
    graphRevision: packageContents.revision.id,
    elements: packageContents.elements,
  });
  return {
    valid: true,
    index: graphIndexSnapshot(index),
  };
}
