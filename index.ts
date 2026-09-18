import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as core from "./core.ts";
import { confirmInBorderedPopup, inputInBorderedPopup, selectInBorderedPopup } from "./ui/bordered-popups.ts";

export type UiContext = Pick<ExtensionContext, "ui">;
let currentEnv: Record<string, string> = {};

type Builder = { Object: (p: Record<string, unknown>) => unknown; String: (o?: unknown) => unknown };
async function getBuilder(pi: ExtensionAPI): Promise<Builder> {
  const injected = (pi as unknown as { typebox?: { Type?: Builder } }).typebox?.Type;
  if (injected?.Object && injected?.String) return injected;
  const zod = (pi as unknown as { zod?: { object?: (p: Record<string, unknown>) => unknown; string?: (o?: unknown) => unknown } }).zod;
  if (zod?.object && zod?.string) return { Object: zod.object, String: zod.string };
  for (const spec of ["typebox", "@sinclair/typebox"]) {
    try {
      const mod = await import(spec) as { Type?: Builder };
      if (mod.Type?.Object) return mod.Type;
    } catch {}
  }
  throw new Error("No TypeBox-compatible schema builder available");
}
function applyEnv(next: Record<string, string>): void {
  for (const key of Object.keys(currentEnv)) if (!(key in next)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
  currentEnv = next;
}

function paths(): core.AuthTargets { return core.getAuthTargets(); }
function mappedError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

let refreshPromise: Promise<void> | null = null;
let refreshTimer: { unref(): void } | null = null;

// Startup must never await the vault: secrets hydrate in the background and the
// agent keeps working with whatever environment it already had.
function refreshEnv(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try { await core.ensureSession(); } catch { scheduleRetry(); }
      applyEnv(await core.buildEnvMap());
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function scheduleRetry(delay = 5000): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshEnv().catch(() => scheduleRetry(Math.min(delay * 2, 60000)));
  }, delay);
  if (typeof refreshTimer === "object" && "unref" in refreshTimer) refreshTimer.unref();
}

async function hydratedEnv(): Promise<Record<string, string>> {
  await refreshEnv();
  return currentEnv;
}

async function report(): Promise<{ report: string; details: Record<string, unknown> }> {
  const status = await core.getStatus();
  const names = Object.keys(await hydratedEnv());
  const report = `Vaultwarden: ${status.status} (bw ${status.version ?? "unknown"}) / server: ${status.serverUrl ?? "unknown"} / items: ${status.items ?? "unknown"} / injected env (names only): ${names.length ? names.join(", ") : "none"}`;
  return { report, details: { status: status.status, version: status.version, items: status.items, injectedEnvNames: names } };
}

async function writeBoth(name: string, itemName: string, overwrite = false): Promise<void> {
  const ref = core.referenceFor(itemName);
  const targets = paths();
  const results = await Promise.all([
    core.writeAuthEntry(targets.omp, name, ref, { overwrite }),
    core.writeAuthEntry(targets.pi, name, ref, { overwrite }),
  ]);
  const failed = results.find((result) => !result.ok);
  if (failed) throw new Error(failed.message);
}

async function addFlow(ctx: UiContext, envName: string, itemName: string, purpose: string): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) return "Invalid env_name; use UPPER_SNAKE_CASE.";
  try {
    await core.ensureSession();
    const secret = await inputInBorderedPopup(ctx, { title: `Paste secret for ${envName}`, prompt: "Value is not shown", mask: true });
    if (!secret) return "Cancelled.";
    await core.createSecretItem({ itemName, secret, envName, notes: purpose });
    await writeBoth(envName, itemName);
    await refreshEnv();
    const verified = (await core.resolveShellValue(core.referenceFor(itemName))) !== null;
    return `created item=${itemName} env=${envName} verified=${verified ? "yes" : "no"}`;
  } catch (error) { return mappedError(error); }
}

async function chooseItem(ctx: UiContext, title: string): Promise<{ id: string; name: string } | null> {
  const query = await inputInBorderedPopup(ctx, { title: "Search Vaultwarden", prompt: "Leave empty to list all items" });
  if (query === undefined) return null;
  const items = await core.findItems(query);
  if (!items.length) { ctx.ui.notify("No Vaultwarden items found.", "warning"); return null; }
  const id = await selectInBorderedPopup(ctx, { title, items: items.map((item) => ({ value: item.id, label: item.name })), maxVisible: 16 });
  return items.find((item) => item.id === id) ?? null;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  let T: Builder;
  try { T = await getBuilder(pi); } catch { return; }
  const emptySchema = T.Object({});
  refreshEnv().catch(() => {});
  // Fires on startup and every resume/fork; cache + single-flight make it free
  // while the vault is warm.
  pi.on("session_start", () => { void refreshEnv(); });

  pi.registerTool({
    name: "vw_diagnose", label: "Vaultwarden Diagnostics",
    description: "Check Vaultwarden state and injected environment names without exposing values.", parameters: emptySchema,
    async execute() { const result = await report(); return { content: [{ type: "text", text: result.report }], details: result.details }; },
  });
  pi.registerTool({
    name: "vw_add_secret", label: "Add Vaultwarden Secret",
    description: "Prompt the user for a masked secret, create a Vaultwarden item, and wire it to both agents.",
    parameters: T.Object({ env_name: T.String({ description: "UPPER_SNAKE_CASE environment variable name" }), item_name: T.String({ description: "Vaultwarden item name to create" }), purpose: T.String({ description: "Short note stored with the item" }) }),
    async execute(_id, params, _signal, _update, ctx) { const input = params as { env_name: string; item_name: string; purpose: string }; const text = await addFlow(ctx, input.env_name, input.item_name, input.purpose); return { content: [{ type: "text", text }] }; },
  });

  pi.registerCommand("vaultwarden_diagnose", { description: "Show Vaultwarden status and secret injection diagnostics.", handler: async (_args, ctx) => { const result = await report(); ctx.ui.notify(result.report, "info"); } });
  pi.registerCommand("vaultwarden_add", { description: "Create and wire a new Vaultwarden secret.", handler: async (_args, ctx) => {
    const itemName = await inputInBorderedPopup(ctx, { title: "Vaultwarden item name", prompt: "Name for the new login item" }); if (!itemName) return;
    const envName = await inputInBorderedPopup(ctx, { title: "Environment variable", prompt: "Use UPPER_SNAKE_CASE" }); if (!envName) return;
    const purpose = await inputInBorderedPopup(ctx, { title: "Purpose", prompt: "Short note stored with the item" }); if (purpose === undefined) return;
    const secret = await inputInBorderedPopup(ctx, { title: `Paste secret for ${envName}`, prompt: "Value is not shown", mask: true }); if (!secret) return;
    if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) { ctx.ui.notify("Invalid env var name; use UPPER_SNAKE_CASE.", "error"); return; }
    if (!await confirmInBorderedPopup(ctx, { title: "Create and wire secret?", message: `"${envName}": "${core.referenceFor(itemName)}"` })) return;
    try { await core.ensureSession(); await core.createSecretItem({ itemName, secret, envName, notes: purpose }); await writeBoth(envName, itemName); await refreshEnv(); ctx.ui.notify(`Created item=${itemName} env=${envName} verified=yes`, "info"); } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
  pi.registerCommand("vaultwarden_setup", { description: "Wire an existing Vaultwarden item to both agent auth stores.", handler: async (_args, ctx) => {
    try {
      await core.ensureSession(); const item = await chooseItem(ctx, "Choose Vaultwarden item"); if (!item) return;
      const envName = await inputInBorderedPopup(ctx, { title: "Environment variable", prompt: "Use UPPER_SNAKE_CASE" }); if (!envName || !/^[A-Z][A-Z0-9_]*$/.test(envName)) { ctx.ui.notify("Invalid env var name; use UPPER_SNAKE_CASE.", "error"); return; }
      const targets = paths(); const existing = (await core.readAuthEntries(targets.omp))[envName] !== undefined || (await core.readAuthEntries(targets.pi))[envName] !== undefined;
      let overwrite = false; if (existing) { const choice = await selectInBorderedPopup(ctx, { title: `${envName} already exists`, items: [{ value: "replace", label: "Replace" }, { value: "keep", label: "Keep" }] }); if (choice !== "replace") return; overwrite = true; }
      if (!await confirmInBorderedPopup(ctx, { title: "Save reference?", message: `"${envName}": "${core.referenceFor(item.name)}"` })) return;
      await writeBoth(envName, item.name, overwrite); await refreshEnv(); ctx.ui.notify("Saved; reload to apply", "info");
    } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
  pi.registerCommand("vaultwarden_rotate", { description: "Rotate a Vaultwarden item's password.", handler: async (_args, ctx) => {
    try { await core.ensureSession(); const item = await chooseItem(ctx, "Choose item to rotate"); if (!item) return; const secret = await inputInBorderedPopup(ctx, { title: `Rotate ${item.name}`, prompt: "Value is not shown", mask: true }); if (!secret) return; if (!await confirmInBorderedPopup(ctx, { title: "Rotate secret?", message: `Item: ${item.name}` })) return; await core.rotateSecretItem({ itemName: item.name, secret }); await refreshEnv(); ctx.ui.notify(`Rotated item=${item.name}; injected environment refreshed.`, "info"); } catch (error) { ctx.ui.notify(mappedError(error), "error"); }
  } });
}

export { core };
export const { resolveShellValue, getSecret, buildEnvMap, writeAuthEntry, deleteAuthEntry, getStatus, ensureSession } = core;
