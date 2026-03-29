#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(projectRoot, "src");

async function transpileManifestModuleSubset(outDir) {
  const typescriptModuleUrl = pathToFileURL(path.join(packageRoot, "node_modules", "typescript", "lib", "typescript.js")).href;
  const typescriptModule = await import(typescriptModuleUrl);
  const ts = typescriptModule.default ?? typescriptModule;

  const files = [
    {
      source: path.join(packageRoot, "src", "install-defaults.ts"),
      output: path.join(outDir, "src", "install-defaults.js"),
    },
    {
      source: path.join(packageRoot, "src", "types.ts"),
      output: path.join(outDir, "src", "types.js"),
    },
    {
      source: path.join(packageRoot, "src", "roles.ts"),
      output: path.join(outDir, "src", "roles.js"),
    },
    {
      source: path.join(packageRoot, "src", "controller", "orchestration-manifest.ts"),
      output: path.join(outDir, "src", "controller", "orchestration-manifest.js"),
    },
  ];

  for (const file of files) {
    const sourceText = await fs.readFile(file.source, "utf8");
    const result = ts.transpileModule(sourceText, {
      fileName: file.source,
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2023,
      },
      reportDiagnostics: true,
    });

    const diagnostics = (result.diagnostics ?? [])
      .filter((diag) => diag.category === ts.DiagnosticCategory.Error)
      .map((diag) => {
        const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        return message;
      });
    assert.equal(
      diagnostics.length,
      0,
      `TypeScript transpile failed for ${path.relative(projectRoot, file.source)}:\n${diagnostics.join("\n")}`,
    );

    await fs.mkdir(path.dirname(file.output), { recursive: true });
    await fs.writeFile(file.output, result.outputText, "utf8");
  }
}

async function runManifestRuntimeChecks() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-manifest-runtime-"));
  try {
    await fs.writeFile(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await fs.symlink(path.join(packageRoot, "node_modules"), path.join(outDir, "node_modules"), "dir");
    await transpileManifestModuleSubset(outDir);

    const manifestModuleUrl = pathToFileURL(path.join(outDir, "src", "controller", "orchestration-manifest.js")).href;
    const manifestModule = await import(manifestModuleUrl);
    const {
      normalizeManifestRoleList,
      normalizeManifestCreatedTasks,
      validateControllerManifest,
      recoverControllerManifestFromText,
    } = manifestModule;

    assert.deepEqual(
      normalizeManifestRoleList(["Product Manager", "QA Engineer", "release engineer", "sre", "unknown role"]),
      ["pm", "qa", "release-engineer", "sre"],
      "manifest role normalization should accept common role labels and aliases while dropping unknown roles",
    );

    assert.deepEqual(
      normalizeManifestCreatedTasks({
        title: "Implement audit log export API",
        assignedRole: "Developer",
        expectedOutcome: "Code, tests, and API notes committed",
      }),
      [{
        title: "Implement audit log export API",
        assignedRole: "developer",
        expectedOutcome: "Code, tests, and API notes committed",
      }],
      "manifest created-task normalization should accept a single object payload and normalize assignedRole aliases",
    );

    const valid = validateControllerManifest({
      requirementSummary: "Ship audit log export",
      requiredRoles: "Product Manager, QA Engineer",
      createdTasks: {
        title: "Implement audit log export API",
        assignedRole: "Developer",
        expectedOutcome: "Code, tests, and API usage notes committed",
      },
      deferredTasks: [{
        title: "Run release validation for audit log export",
        assignedRole: "QA Engineer",
        blockedBy: "Implementation does not exist yet",
        whenReady: "Create this after the developer task is completed",
      }],
      clarificationQuestions: "- Which tenant tiers must receive the export?\n- Is CSV enough or is Parquet required?",
    });
    assert.ok(valid.manifest, "validateControllerManifest should accept salvageable manifest shapes");
    assert.deepEqual(
      valid.manifest?.requiredRoles,
      ["pm", "qa", "developer"],
      "manifest validation should normalize role labels and union task-assigned roles into requiredRoles",
    );
    assert.equal(valid.manifest?.clarificationsNeeded, true, "clarification questions should imply clarificationsNeeded");
    assert.equal(valid.manifest?.clarificationQuestions.length, 2, "multi-line clarificationQuestions should normalize into a string array");

    const invalid = validateControllerManifest({
      requirementSummary: "Ship audit log export",
      requiredRoles: ["Product Manager", "mystery role"],
      createdTasks: [{
        title: "Implement audit log export API",
        assignedRole: "ghost role",
        expectedOutcome: "",
      }],
    });
    assert.equal(invalid.manifest, null, "invalid manifest payloads should be rejected instead of silently normalized");
    assert.match(
      invalid.issues.join("\n"),
      /unknown role|expectedOutcome is required/i,
      "invalid manifest validation should explain role and required-field problems",
    );

    const recovered = recoverControllerManifestFromText([
      "Here is the manifest JSON:",
      "```json",
      "{",
      '  "requirementSummary": "Ship audit log export",',
      '  "requiredRoles": ["Product Manager", "QA Engineer"],',
      '  "createdTasks": [',
      '    {',
      '      "title": "Implement audit log export API",',
      '      "assignedRole": "Developer",',
      '      "expectedOutcome": "Code, tests, and API usage notes committed"',
      "    }",
      "  ],",
      '  "notes": "Recovered from reply text"',
      "}",
      "```",
    ].join("\n"));
    assert.ok(recovered.manifest, "reply recovery should parse manifest JSON from fenced assistant text");
    assert.equal(recovered.manifest?.createdTasks[0]?.assignedRole, "developer");
    assert.equal(recovered.issues.length, 0, "successful reply recovery should not report validation issues");

    console.log("Controller manifest runtime checks passed.");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

await runManifestRuntimeChecks();
