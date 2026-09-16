import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import process from "node:process";
import * as readline from "node:readline";

export const SERVER_HINT = "https://vault.thatnghiep.dev";
export const KEYCHAIN_MASTER_SERVICE = "vaultwarden-master-password";
export const KEYCHAIN_CLIENT_ID_SERVICE = "vaultwarden-api-client-id";
export const KEYCHAIN_CLIENT_SECRET_SERVICE = "vaultwarden-api-client-secret";
export const SESSION_FILE = join(homedir(), ".config", "pi-vaultwarden", "session");

export const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "anthropic", "openai", "azure-openai-responses", "deepseek", "google", "mistral",
  "groq", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai", "xai",
  "openrouter", "vercel-ai-gateway", "zai", "opencode", "opencode-go", "huggingface",
  "fireworks", "together", "kimi-coding", "minimax", "minimax-cn", "xiaomi",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

export interface VaultStatus { status: string; serverUrl: string | null; version: string | null; items: number | null }
export interface AuthTargets { omp: string; pi: string }

interface ExecResult { stdout: string; stderr: string }

function runFile(command: string, args: string[], options: Record<string, unknown> = {}, input?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options as never, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "Command failed").trim();
        reject(new Error(message));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export function getAuthTargets(): AuthTargets {
  return {
    omp: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "auth.json"),
    pi: join(homedir(), ".pi", "agent", "auth.json"),
  };
}

export function referenceFor(itemName: string): string {
  return `!bw get password '${itemName}'`;
}

export async function bw(args: string[], opts: { input?: string; session?: string } = {}): Promise<string> {
  const session = opts.session ?? process.env.BW_SESSION;
  const env = { ...process.env, ...(session ? { BW_SESSION: session } : {}) };
  const result = await runFile("bw", args, { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, opts.input);
  return result.stdout;
}

async function readKeychain(service: string): Promise<string | null> {
  const user = process.env.USER || process.env.LOGNAME || "";
  try {
    const result = await runFile("security", ["find-generic-password", "-a", user, "-s", service, "-w"], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch {}
  try {
    const result = await runFile("secret-tool", ["lookup", "service", service, "account", user], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch {}
  return null;
}

async function readMasterPassword(): Promise<string | null> {
  const keychain = await readKeychain(KEYCHAIN_MASTER_SERVICE);
  if (keychain) return keychain;
  try {
    return (await readFile(join(homedir(), ".config", "pi-vaultwarden", "master-password"), "utf8")).trim() || null;
  } catch { return null; }
}

async function readCredential(service: string): Promise<string | null> {
  return readKeychain(service);
}

async function rawStatus(session?: string): Promise<{ status: string; serverUrl: string | null }> {
  try {
    const parsed = JSON.parse(await bw(["status"], { session })) as { status?: unknown; serverUrl?: unknown };
    return { status: typeof parsed.status === "string" ? parsed.status : "unknown", serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : null };
  } catch {
    return { status: "unavailable", serverUrl: null };
  }
}

export async function ensureSession(): Promise<string> {
  const existing = process.env.BW_SESSION?.trim();
  if (existing && (await rawStatus(existing)).status === "unlocked") return existing;

  try {
    const cached = (await readFile(SESSION_FILE, "utf8")).trim();
    if (cached) {
      process.env.BW_SESSION = cached;
      if ((await rawStatus(cached)).status === "unlocked") return cached;
    }
  } catch {}

  const master = await readMasterPassword();
  if (!master) throw new Error("Vaultwarden master password not available");

  const beforeLogin = await rawStatus();
  if (beforeLogin.status === "unauthenticated") {
    const clientId = await readCredential(KEYCHAIN_CLIENT_ID_SERVICE);
    const clientSecret = await readCredential(KEYCHAIN_CLIENT_SECRET_SERVICE);
    if (clientId && clientSecret) {
      try {
        await runFile("bw", ["login", "--apikey"], { env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      } catch {}
    }
  }

  const unlocked = await runFile("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
    env: { ...process.env, BW_PASSWORD: master }, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  const token = unlocked.stdout.trim();
  if (!token) throw new Error("Vaultwarden unlock returned no session");
  await mkdir(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${SESSION_FILE}.tmp.${process.pid}`;
  await writeFile(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, SESSION_FILE);
  await chmod(SESSION_FILE, 0o600);
  process.env.BW_SESSION = token;
  try { await bw(["sync", "--quiet"], { session: token }); } catch {}
  return token;
}

export async function getStatus(): Promise<VaultStatus> {
  let status = "unavailable";
  let serverUrl: string | null = null;
  let version: string | null = null;
  let items: number | null = null;
  try {
    const parsed = JSON.parse(await bw(["status"])) as { status?: unknown; serverUrl?: unknown };
    status = typeof parsed.status === "string" ? parsed.status : status;
    serverUrl = typeof parsed.serverUrl === "string" ? parsed.serverUrl : null;
  } catch {}
  try { version = (await bw(["--version"])).trim() || null; } catch {}
  if (status === "unlocked") {
    try { items = (await findItems("")).length; } catch {}
  }
  return { status, serverUrl, version, items };
}

export async function resolveShellValue(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (!value.startsWith("!")) return value;
  try {
    const command = value.slice(1).trim();
    if (command.startsWith("bw ")) await ensureSession();
    const result = await runFile("/bin/sh", ["-c", command], { env: process.env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim() || null;
  } catch { return null; }
}

export async function readAuthEntries(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      return async () => { try { await unlink(path); } catch {} };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (Date.now() - start > 5000) { try { await unlink(path); } catch {} }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

export async function writeAuthEntry(path: string, name: string, key: string, opts: { overwrite?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    const current = await readAuthEntries(path);
    if (Object.hasOwn(current, name) && opts.overwrite !== true) return { ok: false, message: `${name} already exists in ${path}` };
    const next = { ...current, [name]: { type: "api_key", key } };
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
    return { ok: true, message: "Entry saved." };
  } finally { await release(); }
}

export async function deleteAuthEntry(path: string, name: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireLock(`${path}.lock`);
  try {
    const current = await readAuthEntries(path);
    if (!Object.hasOwn(current, name)) return false;
    const next = { ...current };
    delete next[name];
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
    return true;
  } finally { await release(); }
}

export async function buildEnvMap(): Promise<Record<string, string>> {
  try {
    const targets = getAuthTargets();
    const merged = { ...(await readAuthEntries(targets.pi)), ...(await readAuthEntries(targets.omp)) };
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(merged)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || PROVIDER_KEYS.has(key)) continue;
      const raw = typeof entry === "string" ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { key?: unknown }).key : undefined;
      const value = process.env[key] ?? await resolveShellValue(raw);
      if (value !== null && value !== undefined && value !== "") result[key] = value;
    }
    return result;
  } catch { return {}; }
}

function mapItemError(error: unknown, name: string): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("More than one result was found")) return new Error(`Ambiguous vault item name: ${name}`);
  if (text.includes("Not found.")) return new Error(`Vault item not found: ${name}`);
  return error instanceof Error ? error : new Error(text);
}

export async function findItems(search: string): Promise<Array<{ id: string; name: string }>> {
  const parsed = JSON.parse(await bw(["list", "items", "--search", search])) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const value = item as { id?: unknown; name?: unknown; title?: unknown };
    return { id: String(value.id ?? ""), name: String(value.name ?? value.title ?? "") };
  }).filter((item) => item.id && item.name);
}

export async function getSecret(itemName: string): Promise<string> {
  try { return await bw(["get", "password", itemName]); } catch (error) { throw mapItemError(error, itemName); }
}

export async function createSecretItem(opts: { itemName: string; secret: string; envName?: string; notes?: string }): Promise<{ id: string }> {
  const existing = await findItems(opts.itemName);
  if (existing.some((item) => item.name.toLowerCase() === opts.itemName.toLowerCase())) throw new Error(`Vault item already exists: ${opts.itemName}`);
  const item: Record<string, unknown> = {
    type: 1, name: opts.itemName, notes: opts.notes ?? null, favorite: false, reprompt: 0,
    login: { uris: [], username: "agent", password: opts.secret, totp: null },
  };
  if (opts.envName) item.fields = [{ type: 0, name: "env", value: opts.envName }];
  const output = await bw(["create", "item"], { input: Buffer.from(JSON.stringify(item), "utf8").toString("base64") });
  let created: { id?: unknown };
  try { created = JSON.parse(output) as { id?: unknown }; } catch { throw new Error("Vaultwarden create returned invalid JSON"); }
  if (!created.id) throw new Error("Vaultwarden create returned no item id");
  await bw(["sync", "--quiet"]);
  return { id: String(created.id) };
}

export async function rotateSecretItem(opts: { itemName: string; secret: string }): Promise<{ id: string }> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(await bw(["get", "item", opts.itemName])) as Record<string, unknown>; } catch (error) { throw mapItemError(error, opts.itemName); }
  const login = parsed.login && typeof parsed.login === "object" ? parsed.login as Record<string, unknown> : {};
  parsed.login = { ...login, password: opts.secret };
  const id = String(parsed.id ?? "");
  if (!id) throw new Error(`Vault item not found: ${opts.itemName}`);
  await bw(["edit", "item", id], { input: Buffer.from(JSON.stringify(parsed), "utf8").toString("base64") });
  await bw(["sync", "--quiet"]);
  return { id };
}

export async function deleteItem(id: string, permanent = false): Promise<void> {
  await bw(["delete", "item", id, ...(permanent ? ["--permanent"] : [])]);
}

export async function readSecretFromInput(opts: { prompt: string; stdin: boolean }): Promise<string> {
  if (opts.stdin || !process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    input = input.replace(/\r?\n$/, "");
    if (!input) throw new Error("Empty secret");
    return input;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
  process.stderr.write(opts.prompt);
  const value = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  if (!value) throw new Error("Empty secret");
  return value;
}
