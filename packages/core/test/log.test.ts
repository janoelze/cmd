import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LogFile, crashDir, formatLine, logDir, recordCrash, type CrashReport } from "@cmd/protocol/node";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("logDir", () => {
  it("prefers CMD_LOG_DIR, then CMD_HOME/logs", () => {
    process.env.CMD_HOME = "/state";
    process.env.CMD_LOG_DIR = "/logs";
    expect(logDir()).toBe("/logs");
    delete process.env.CMD_LOG_DIR;
    expect(logDir()).toBe(path.join("/state", "logs"));
  });

  it("uses ~/Library/Logs/cmd on macOS", () => {
    delete process.env.CMD_HOME;
    delete process.env.CMD_LOG_DIR;
    if (process.platform === "darwin") expect(logDir()).toBe(path.join(os.homedir(), "Library", "Logs", "cmd"));
  });
});

describe("LogFile", () => {
  it("writes lines and keeps a tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-log-"));
    const f = new LogFile("core", dir);
    f.write(formatLine("info", "panes", "pane started", [{ pid: 1 }], new Date(0)));
    f.write(formatLine("error", "rpc", "boom", [new Error("bad")], new Date(0)));
    const text = fs.readFileSync(path.join(dir, "core.log"), "utf8");
    expect(text).toContain('1970-01-01T00:00:00.000Z INFO  [panes] pane started {"pid":1}');
    expect(text).toContain("ERROR [rpc] boom Error: bad\n    at ");
    expect(f.tail[0]).toContain("pane started");
  });

  it("rotates at 5 MB", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-log-"));
    fs.writeFileSync(path.join(dir, "main.log"), "x".repeat(5 * 1024 * 1024 + 1));
    new LogFile("main", dir).write("fresh");
    expect(fs.readFileSync(path.join(dir, "main.log"), "utf8")).toBe("fresh\n");
    expect(fs.statSync(path.join(dir, "main.1.log")).size).toBeGreaterThan(5 * 1024 * 1024);
  });
});

describe("recordCrash", () => {
  it("writes a report with the app's context", () => {
    process.env.CMD_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-log-"));
    process.env.CMD_APP_VERSION = "1.2.3";
    process.env.CMD_INSTANCE = "dev";
    const file = recordCrash({ process: "core", kind: "uncaughtException", message: "TypeError: x", stack: "TypeError: x\n    at f (a.ts:1:1)", log: ["line"] });
    expect(path.dirname(file!)).toBe(crashDir());
    const r: CrashReport = JSON.parse(fs.readFileSync(file!, "utf8"));
    expect(r).toMatchObject({ process: "core", kind: "uncaughtException", message: "TypeError: x", log: ["line"] });
    expect(r.context).toMatchObject({ version: "1.2.3", channel: "dev" });
  });
});
