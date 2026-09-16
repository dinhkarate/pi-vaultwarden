import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UiContext } from "../index.ts";

export function renderBorderedBox(width: number, title: string, bodyLines: string[], footer: string | undefined, theme: Pick<Theme, "fg" | "bold">, truncateToWidthFn: Function): string[] {
  const innerWidth = Math.max(20, width - 4);
  const top = theme.fg("accent", `╭${"─".repeat(width - 2)}╮`);
  const bottom = theme.fg("accent", `╰${"─".repeat(width - 2)}╯`);
  const titlePadded = truncateToWidthFn(theme.fg("accent", theme.bold(title)), innerWidth, "", true);
  const borderedTitle = theme.fg("accent", "│ ") + titlePadded + theme.fg("accent", " │");
  const borderedBody = bodyLines.map((line) => theme.fg("accent", "│ ") + truncateToWidthFn(line || "", innerWidth, "", true) + theme.fg("accent", " │"));
  const lines = [top, borderedTitle, ...borderedBody];
  if (footer) lines.push(theme.fg("accent", "│ ") + truncateToWidthFn(theme.fg("dim", footer), innerWidth, "", true) + theme.fg("accent", " │"));
  lines.push(bottom);
  return lines;
}

export async function selectInBorderedPopup<T = string>(ctx: UiContext, opts: { title: string; message?: string; items: { value: T; label: string; description?: string }[]; helpText?: string; maxVisible?: number }): Promise<T | null> {
  const maxVis = opts.maxVisible ?? 14;
  const help = opts.helpText ?? "↑↓ • Enter • Esc = cancel • Type to filter";
  interface SelectListHandle { render(w: number): string[]; invalidate(): void; handleInput(d: string): void; onSelect: (item: { value: T }) => void; onCancel: () => void }
  return await ctx.ui.custom<T | null>(async (tui, theme, _kb, done) => {
    const piTui = await import("@earendil-works/pi-tui") as unknown as { SelectList: new (items: { value: T; label: string; description?: string }[], maxVisible: number, theme: unknown) => SelectListHandle; Container: new () => { invalidate(): void }; truncateToWidth: (s: string, w: number, e?: string, pad?: boolean) => string };
    const list = new piTui.SelectList(opts.items, maxVis, { selectedPrefix: (t: string) => theme.fg("accent", t), selectedText: (t: string) => theme.fg("accent", t), description: (t: string) => theme.fg("muted", t), scrollInfo: (t: string) => theme.fg("dim", t), noMatch: (t: string) => theme.fg("warning", t) });
    list.onSelect = (item) => done(item.value); list.onCancel = () => done(null);
    const container = new piTui.Container();
    return { render(width: number) { const body: string[] = []; if (opts.message) { body.push(...opts.message.split("\n").map((line) => theme.fg("text", line)), ""); } body.push(...list.render(Math.max(20, width - 4))); return renderBorderedBox(width, opts.title, body, help, theme, piTui.truncateToWidth); }, invalidate() { container.invalidate(); list.invalidate(); }, handleInput(data: string) { list.handleInput(data); tui.requestRender(); } };
  }, { overlay: true });
}

export async function confirmInBorderedPopup(ctx: UiContext, opts: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean> {
  const choice = await selectInBorderedPopup(ctx, { title: opts.title, message: opts.message, items: [{ value: true, label: opts.confirmLabel ?? "Yes" }, { value: false, label: opts.cancelLabel ?? "No" }], helpText: "↑↓ • Enter to confirm • Esc = cancel", maxVisible: 5 });
  return choice === true;
}

export async function inputInBorderedPopup(ctx: UiContext, opts: { title: string; prompt?: string; defaultValue?: string; helpText?: string; mask?: boolean }): Promise<string | undefined> {
  const help = opts.helpText ?? "Enter to confirm • Esc = cancel";
  interface EditorHandle { render(w: number): string[]; invalidate(): void; handleInput(d: string): void; setText(s: string): void; getText(): string; onSubmit: (value: string) => void }
  return await ctx.ui.custom<string | undefined>(async (tui, theme, _kb, done) => {
    const piTui = await import("@earendil-works/pi-tui") as unknown as { Editor: new (tui: unknown, theme: unknown) => EditorHandle; matchesKey: (data: string, key: string) => boolean; truncateToWidth: (s: string, w: number, e?: string, pad?: boolean) => string };
    const editor = new piTui.Editor(tui, { borderColor: (s: string) => theme.fg("accent", s), selectList: {} });
    if (opts.defaultValue) editor.setText(opts.defaultValue);
    editor.onSubmit = (value) => done(value.trim() || undefined);
    return { render(width: number) { const body: string[] = []; if (opts.prompt) body.push(...opts.prompt.split("\n").map((line) => theme.fg("text", line)), ""); if (opts.mask) body.push(theme.fg("text", "•".repeat([...editor.getText()].length))); else body.push(...editor.render(Math.max(20, width - 4))); return renderBorderedBox(width, opts.title, body, help, theme, piTui.truncateToWidth); }, invalidate() { editor.invalidate(); }, handleInput(data: string) { if (piTui.matchesKey(data, "escape")) { done(undefined); return; } editor.handleInput(data); tui.requestRender(); } };
  }, { overlay: true });
}
