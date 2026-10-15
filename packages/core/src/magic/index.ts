// What `cmd magic` and `cmd widget` use of the core without one running (the prompt lab, evals).
export * from "../ai/index.ts";
export { classify, credentialsFor, credentialsForPrograms, DEFAULT_DENY_PATHS, isDeniedPath, redact } from "../lib/policy.ts";
export { execArgv, execCommand, sandboxAvailable, sandboxMode, sandboxProfile, type SandboxMode } from "../lib/sandbox.ts";
export { TOOL_SPECS, toolsFor, runTool, preview } from "./tools.ts";
export { readSecrets, SecretsService } from "../kernel/secrets.ts";
export { RUNTIME_DIR, DENO_VERSION, findDeno, installDeno, bundledDeno, denoVersion } from "../widgets/deno.ts";
export { playwrightPreviewer, previewPageBuilt, type Previewer } from "./previewer.ts";
export { buildPackage, verifyPackage, fastCommand, stepLog, stepDetail, type BuildEvent, type BuildRoute, type TraceStep, type PackageBuildOptions, type PackageBuildResult, type PackageVerdict } from "./package/build.ts";
export { drawTrees, judge, type DrawnTree } from "./package/preview.ts";
export { checkoutToolchain, linkDevModules, REPO, type Toolchain, type TreeVariant } from "./package/toolchain.ts";
export { envTypes, writeEnvTypes, ENV_TYPES_FILE } from "../widgets/env-types.ts";
export { buildPackageSystem, buildPackageRequest, promptHash, examples, exampleFiles, PROMPT_DIR, type Workspace } from "./package/prompt.ts";
export { scriptedBackend, type Script, type ScriptTurn } from "./package/scripted.ts";
export { slugOf, wantsText } from "./package/service.ts";
export { PACKAGE_TOOL_SPECS } from "./package/tools.ts";
