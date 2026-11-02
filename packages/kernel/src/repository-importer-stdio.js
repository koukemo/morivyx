#!/usr/bin/env node
import { importRepositoryFile, validateRepositoryImportResult } from "./repository-importer.js";
import { servePluginStdio } from "./plugin-stdio.js";

const result = await servePluginStdio({
  handleRequest: importRepositoryFile,
  validateResult: validateRepositoryImportResult,
});
process.exitCode = result.exitCode;
