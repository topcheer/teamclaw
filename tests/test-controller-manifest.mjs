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
      // Canonical role id list (Phase 1.2 single-source convergence); both
      // roles.ts (drift guard) and prompt-policy.ts import it at runtime.
      source: path.join(packageRoot, "src", "role-ids.ts"),
      output: path.join(outDir, "src", "role-ids.js"),
    },
    {
      // roles.ts imports prompt-policy.js at runtime (composePrompt and role
      // operating rules); needed ever since orchestration-manifest.ts started
      // delegating its role guard to validateRoleIdList in roles.ts (Phase 0.3).
      source: path.join(packageRoot, "src", "prompt-policy.ts"),
      output: path.join(outDir, "src", "prompt-policy.js"),
    },
    {
      source: path.join(packageRoot, "src", "openclaw-workspace.ts"),
      output: path.join(outDir, "src", "openclaw-workspace.js"),
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
      normalizeControllerManifest,
    } = manifestModule;

    assert.deepEqual(
      normalizeManifestRoleList(["pm", "Product Manager", "qa", "sre", "unknown role", "pm", "data-engineer"]),
      ["pm", "qa", "data-engineer"],
      "manifest role normalization should keep exact role ids (dropping labels, aliases, and unknowns) while deduping",
    );

    assert.deepEqual(
      normalizeManifestCreatedTasks([{
        title: "Implement audit log export API",
        assignedRole: "developer",
        expectedOutcome: "Code, tests, and API notes committed",
      }]),
      [{
        title: "Implement audit log export API",
        assignedRole: "developer",
        expectedOutcome: "Code, tests, and API notes committed",
      }],
      "manifest created-task normalization should keep exact-id tasks and drop entries without title/outcome",
    );
    assert.deepEqual(
      normalizeManifestCreatedTasks({ title: "single object", assignedRole: "developer", expectedOutcome: "x" }),
      [],
      "manifest created-task normalization only accepts array payloads (single objects are dropped)",
    );

    const valid = normalizeControllerManifest({
      requirementSummary: "Ship audit log export",
      requiredRoles: ["pm", "qa", "developer"],
      createdTasks: [{
        title: "Implement audit log export API",
        assignedRole: "developer",
        expectedOutcome: "Code, tests, and API usage notes committed",
      }],
      deferredTasks: [{
        title: "Run release validation for audit log export",
        assignedRole: "qa",
        blockedBy: "Implementation does not exist yet",
        whenReady: "Create this after the developer task is completed",
      }],
      clarificationQuestions: ["Which tenant tiers must receive the export?", "Is CSV enough or is Parquet required?"],
      clarificationsNeeded: true,
    });
    assert.ok(valid, "normalizeControllerManifest should accept manifest payloads with exact role ids");
    assert.deepEqual(
      valid?.requiredRoles,
      ["pm", "qa", "developer"],
      "manifest normalization should keep exact required role ids",
    );
    assert.equal(valid?.clarificationsNeeded, true, "clarificationsNeeded should pass through");
    assert.equal(valid?.clarificationQuestions.length, 2, "clarificationQuestions should normalize into a string array");

    const invalid = normalizeControllerManifest({
      requiredRoles: ["pm"],
      createdTasks: [{ title: "x", assignedRole: "developer", expectedOutcome: "y" }],
    });
    assert.equal(invalid, null, "manifest payloads without requirementSummary should be rejected");

    console.log("Controller manifest runtime checks passed.");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

await runManifestRuntimeChecks();
