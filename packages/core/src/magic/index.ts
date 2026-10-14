// What `cmd magic` and `cmd widget` use of the core without one running (the prompt lab, evals).
export * from "../ai/index.ts";
export { classify, credentialsFor, credentialsForPrograms, DEFAULT_DENY_PATHS, isDeniedPath, redact } from "../lib/policy.ts";
export { execArgv, execCommand, sandboxAvailable, sandboxProfile, type SandboxMode } from "../lib/sandbox.ts";
export { TOOL_SPECS, toolsFor, runTool, preview } from "./tools.ts";
export { readSecrets, SecretsService } from "../kernel/secrets.ts";
export { RUNTIME_DIR, DENO_VERSION, findDeno, installDeno, bundledDeno, denoVersion } from "../widgets/deno.ts";
export { playwrightPreviewer, STRIP, WIDE, MEASURE, type Previewer, type PreviewRequest, type PreviewShot } from "./previewer.ts";
export { buildPackage, verifyPackage, fastCommand, type BuildEvent, type BuildRoute, type TraceStep, type PackageBuildOptions, type PackageBuildResult, type PackageVerdict } from "./package/build.ts";
export { checkoutToolchain, type Toolchain } from "./package/toolchain.ts";
export { buildPackageSystem, buildPackageRequest, promptHash, examples, exampleFiles, PROMPT_DIR, type Workspace } from "./package/prompt.ts";
export { scriptedBackend, type Script, type ScriptTurn } from "./package/scripted.ts";
export { slugOf, wantsText } from "./package/service.ts";
export { PACKAGE_TOOL_SPECS } from "./package/tools.ts";
