#!/usr/bin/env node
import { importOpenApiOperation, validateOpenApiImportRequest, validateOpenApiImportResult } from "./openapi-importer.js";
import { servePluginStdio } from "./plugin-stdio.js";

const result = await servePluginStdio({ handleRequest: importOpenApiOperation,
  validateRequest: validateOpenApiImportRequest, validateResult: validateOpenApiImportResult });
process.exitCode = result.exitCode;
