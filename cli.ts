#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import * as core from "./core.ts";

const usage = "Usage: pi-vaultwarden <status|unlock|env|get|api-key|exec|add|rotate|wire|unwire|link-cli|claude-setup|doctor> ...";
const targetPaths = core.getAuthTargets();
function fail(message: string, code: number): never { console.error(message); process.exit(code); }
function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function targetList(value: string | undefined): string[] {
  if (!value || value === "both") return [targetPaths.omp, targetPaths.pi];
  if (value === "omp") return [targetPaths.omp];
  if (value === "pi") return [targetPaths.pi];
  fail("--target must be omp, pi, or both", 2);
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function failureCode(error: unknown): number {
  const text = error instanceof Error ? error.message : String(error);
  if (/already exists|already exists in/.test(text)) return 5;
  if (/not found|Ambiguous|Empty secret|unresolved|No value/.test(text)) return 4;
  return 3;
}
async function authValue(name: string): Promise<string | null> {
  const merged = { ...(await core.readAuthEntries(targetPaths.pi)), ...(await core.readAuthEntries(targetPaths.omp)) };
  const entry = merged[name];
  const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { key?: unknown }).key : undefined;
  return core.resolveShellValue(raw);
}
function timestamp(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const command = args.shift(); if (!command) fail(usage, 2);
  try {
    if (command === "status") {
      try { await core.ensureSession(); } catch {}
      const s = await core.getStatus();
      console.log(`server=${s.serverUrl ?? core.SERVER_HINT} status=${s.status} items=${s.items ?? "unknown"} bw=${s.version ?? "unknown"}`);
      if (s.status !== "unlocked") process.exitCode = 3;
      return;
    }
    if (command === "unlock") { await core.ensureSession(); console.log("unlocked"); return; }
    if (command === "env") {
      if (args.some((arg) => arg !== "--shell")) fail(usage, 2);
      const map = await core.buildEnvMap();
      if (args.includes("--shell")) for (const [name, value] of Object.entries(map)) console.log(`export ${name}=${shellQuote(value)}`);
      else for (const name of Object.keys(map)) console.log(name);
      return;
    }
    if (command === "get") {
      if (args.length !== 1) fail(usage, 2);
      const value = await authValue(args[0]); if (value === null) fail(`Secret unresolved: ${args[0]}`, 4);
      process.stdout.write(value); return;
    }
    if (command === "api-key") {
      const item = valueAfter(args, "--item");
      if (!item || args.some((arg, index) => arg !== "--item" && arg !== item && index !== args.indexOf("--item") + 1)) fail(usage, 2);
      await core.ensureSession(); process.stdout.write(await core.getSecret(item)); return;
    }
    if (command === "exec") {
      if (args[0] !== "--" || !args[1]) fail(usage, 2);
      await core.ensureSession(); const map = await core.buildEnvMap();
      const child = spawn(args[1], args.slice(2), { stdio: "inherit", env: { ...process.env, ...map } });
      await new Promise<void>((done) => {
        child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); done(); });
        child.on("error", (error) => { console.error(error.message); process.exitCode = 3; done(); });
      });
      return;
    }
    if (command === "add") {
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item"); const notes = valueAfter(args, "--notes");
      if (!envName || !itemName || !/^[A-Z][A-Z0-9_]*$/.test(envName)) fail(usage, 2);
      const allowed = new Set(["--env", envName, "--item", itemName, "--notes", notes, "--target", valueAfter(args, "--target"), "--stdin"]);
      if (args.some((arg) => !allowed.has(arg))) fail(usage, 2);
      await core.ensureSession();
      const secret = await core.readSecretFromInput({ prompt: `Paste secret for ${envName}: `, stdin: args.includes("--stdin") });
      await core.createSecretItem({ itemName, secret, envName, notes });
      const targets = targetList(valueAfter(args, "--target")); let conflict = false;
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, core.referenceFor(itemName)); if (!result.ok) conflict = true; }
      const verified = (await core.resolveShellValue(core.referenceFor(itemName))) !== null;
      console.log(`created item=${itemName} env=${envName} targets=${targets.join(",")} verified=${verified ? "yes" : "no"}`);
      if (conflict) { console.error("Item created, but one or more auth targets already contained the environment name."); process.exitCode = 5; }
      return;
    }
    if (command === "rotate") {
      const itemName = valueAfter(args, "--item"); if (!itemName || args.some((arg) => arg !== "--item" && arg !== itemName && arg !== "--stdin")) fail(usage, 2);
      await core.ensureSession(); const secret = await core.readSecretFromInput({ prompt: "Paste replacement secret: ", stdin: args.includes("--stdin") });
      await core.rotateSecretItem({ itemName, secret }); console.log(`rotated item=${itemName}`); return;
    }
    if (command === "wire") {
      const envName = valueAfter(args, "--env"); const itemName = valueAfter(args, "--item");
      if (!envName || !itemName || !/^[A-Z][A-Z0-9_]*$/.test(envName)) fail(usage, 2);
      const targets = targetList(valueAfter(args, "--target"));
      for (const path of targets) { const result = await core.writeAuthEntry(path, envName, core.referenceFor(itemName), { overwrite: args.includes("--force") }); if (!result.ok) fail(result.message, 5); }
      console.log(`wired env=${envName} item=${itemName} targets=${targets.join(",")}`); return;
    }
    if (command === "unwire") {
      const envName = valueAfter(args, "--env"); if (!envName) fail(usage, 2);
      const targets = targetList(valueAfter(args, "--target")); const names: string[] = [];
      for (const path of targets) if (await core.deleteAuthEntry(path, envName)) names.push(path);
      console.log(`removed env=${envName} targets=${names.join(",") || "none"}`); return;
    }
    if (command === "link-cli") {
      const dir = resolve(valueAfter(args, "--dir") ?? join(homedir(), ".local", "bin")); const destination = join(dir, "pi-vaultwarden");
      await mkdir(dir, { recursive: true }); const source = fileURLToPath(new URL("./cli.ts", import.meta.url));
      try {
        const linked = await readlink(destination);
        if (resolve(dir, linked) !== source && !args.includes("--force")) fail(`Refusing existing different symlink: ${destination}`, 5);
        await unlink(destination);
      } catch (error) { if ((error as { code?: string }).code !== "ENOENT") { if (!args.includes("--force")) fail(`Refusing existing path: ${destination}`, 5); await unlink(destination).catch(() => {}); } }
      await symlink(source, destination); await chmod(source, 0o755); console.log(destination); return;
    }
    if (command === "claude-setup") {
      const itemName = valueAfter(args, "--item"); if (!itemName) fail(usage, 2);
      const settingsPath = resolve(valueAfter(args, "--settings") ?? join(homedir(), ".claude", "settings.json"));
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.apiKeyHelper && !args.includes("--force")) fail("apiKeyHelper already set; use --force to replace it", 5);
      await copyFile(settingsPath, `${settingsPath}.bak-${timestamp()}`);
      const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url)); settings.apiKeyHelper = `${cliPath} api-key --item ${shellQuote(itemName)}`;
      const ttl = valueAfter(args, "--ttl-ms"); if (ttl) { if (!/^\d+$/.test(ttl)) fail(usage, 2); settings.env = { ...(settings.env as Record<string, unknown> ?? {}), CLAUDE_CODE_API_KEY_HELPER_TTL_MS: ttl }; }
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }); console.log(`configured apiKeyHelper for item=${itemName}`); return;
    }
    if (command === "doctor") {
      const s = await core.getStatus(); console.log(`bw present/version=${s.version ?? "no"}`); console.log(`bw server=${s.serverUrl ?? "unknown"}`); console.log(`session=${s.status}`);
      for (const path of [targetPaths.omp, targetPaths.pi]) for (const name of Object.keys(await core.readAuthEntries(path))) console.log(`${path} ${name} resolved=${(await authValue(name)) ? "yes" : "no"}`);
      const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
      console.log(`apiKeyHelper wired=${settings.apiKeyHelper ? "yes" : "no"}`); if (s.status !== "unlocked") process.exitCode = 3; return;
    }
    fail(usage, 2);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = failureCode(error); }
}
void main();
