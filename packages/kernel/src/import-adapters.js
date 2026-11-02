import { PackageError } from "./errors.js";
import { validateFigmaImportRequest, validateFigmaImportResult } from "./figma-importer.js";
import { compareFigmaImportSnapshots } from "./figma-reimport.js";
import { validateGitHubImportRequest, validateGitHubImportResult } from "./github-importer.js";
import { compareGitHubImportSnapshots } from "./github-reimport.js";
import { validateOpenApiImportRequest, validateOpenApiImportResult } from "./openapi-importer.js";
import { compareOpenApiImportSnapshots } from "./openapi-reimport.js";
import { validateRepositoryImportRequest, validateRepositoryImportResult, compareRepositoryImportSnapshots } from "./repository-importer.js";

// Internal allowlist. A Plugin cannot register or replace Core-side validation through its manifest.
const ADAPTERS = new Map([
  ["morivyx.figma-importer.dev", Object.freeze({ system: "figma", effect: "read-only",
    inputFormat: "morivyx.figma-node-input/0.1", outputFormat: "morivyx.figma-node-snapshot/0.1",
    validateRequest: validateFigmaImportRequest, validateResult: validateFigmaImportResult, compare: compareFigmaImportSnapshots })],
  ["morivyx.repository-importer.dev", Object.freeze({ system: "repository", effect: "read-only",
    inputFormat: "morivyx.repository-read-input/0.1", outputFormat: "morivyx.repository-file-snapshot/0.1",
    validateRequest: validateRepositoryImportRequest, validateResult: validateRepositoryImportResult, compare: compareRepositoryImportSnapshots })],
  ["morivyx.github-importer.dev", Object.freeze({ system: "github", effect: "read-only",
    inputFormat: "morivyx.github-read-input/0.1", outputFormat: "morivyx.github-file-snapshot/0.1",
    validateRequest: validateGitHubImportRequest, validateResult: validateGitHubImportResult, compare: compareGitHubImportSnapshots })],
  ["morivyx.openapi-importer.dev", Object.freeze({ system: "openapi", effect: "pure",
    inputFormat: "morivyx.openapi-operation-input/0.1", outputFormat: "morivyx.openapi-operation-snapshot/0.1",
    validateRequest: validateOpenApiImportRequest, validateResult: validateOpenApiImportResult, compare: compareOpenApiImportSnapshots })],
]);
export function importAdapter(result) {
  const value = ADAPTERS.get(result?.plugin?.id);
  if (!value) throw new PackageError("IMPORT_ADAPTER_UNSUPPORTED", "/import", "取込形式を確認できません。");
  return value;
}
