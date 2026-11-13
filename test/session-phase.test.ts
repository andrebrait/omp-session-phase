import { afterEach, expect, test } from "bun:test";
import { composeTitle, type MirrorState, hasPhaseMarker, normalizeRef, parseTitle, startTitleMirror, syncHerdr } from "../src/session-phase";

type ExecCall = { command: string; args: string[] };

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "wA:p1", HERDR_TAB_ID: "wA:t1", HERDR_BIN_PATH: "/bin/herdr" };

function fakeHerdr(paneCount: number, failOn?: string, errorOn?: string) {
	const calls: ExecCall[] = [];
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		const failed = failOn && args.join(" ").startsWith(failOn);
		const query = `${args[0]} ${args[1]}`;
		let stdout = query === "tab get" ? JSON.stringify({ result: { tab: { pane_count: paneCount } } }) : "";
		// Herdr answers an API error in the payload and still exits 0.
		if (errorOn && query === errorOn) {
			stdout = JSON.stringify({ error: { code: "pane_not_found", message: `${query} target missing` } });
		}
		return {
			stdout,
			stderr: failed ? "no such pane" : "",
			code: failed ? 1 : 0,
			killed: false,
		};
	};
	return { calls, exec };
}

afterEach(() => {
	for (const key of Object.keys(HERDR_ENV)) delete process.env[key];
});

test("composes emoji + ref + slug", () => {
	expect(composeTitle("triage", { ref: "issue:2725", slug: "HTTP 404" }, undefined)).toBe("🔬 #2725: HTTP 404");
	expect(composeTitle("fix", { ref: "ADR-42", slug: "cron drift" }, undefined)).toBe("🛠️ ADR-42: cron drift");
	expect(composeTitle("waiting", { slug: "pkg repo sync" }, undefined)).toBe("⏸️ pkg repo sync");
});

test("inherits ref and slug from the current name on a phase move", () => {
	const triage = composeTitle("triage", { ref: "2725", slug: "HTTP 404" }, undefined);
	expect(composeTitle("review", {}, triage)).toBe("👀 #2725: HTTP 404");
	expect(composeTitle("ci", { slug: "HTTP 404 retry" }, triage)).toBe("⏳ #2725: HTTP 404 retry");
});

test("keeps an auto-generated title as the slug instead of eating it as a ref", () => {
	expect(parseTitle("Fix: the DNSBL parser")).toEqual({ ref: undefined, slug: "Fix: the DNSBL parser" });
	expect(composeTitle("plan", {}, "Fix: the DNSBL parser")).toBe("📝 Fix: the DNSBL parser");
});

test("falls back to the phase word when nothing names the task", () => {
	expect(composeTitle("question", {}, undefined)).toBe("❓ question");
});

test("normalizes refs and bounds lengths", () => {
	expect(normalizeRef("#2725")).toBe("#2725");
	expect(normalizeRef("PR/3043")).toBe("#3043");
	expect(normalizeRef("  ")).toBeUndefined();
	expect(composeTitle("done", { slug: "x".repeat(80) }, undefined)).toBe(`✅ ${"x".repeat(44)}`);
});

test("mirrors the title onto the herdr pane and a single-pane tab", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { calls, exec } = fakeHerdr(1);

	expect(await syncHerdr(exec, "🔬 #2725: HTTP 404")).toBeUndefined();
	expect(calls).toEqual([
		{ command: "/bin/herdr", args: ["pane", "rename", "wA:p1", "🔬 #2725: HTTP 404"] },
		{ command: "/bin/herdr", args: ["tab", "get", "wA:t1"] },
		{ command: "/bin/herdr", args: ["tab", "rename", "wA:t1", "🔬 #2725: HTTP 404"] },
	]);
});

test("leaves a shared tab's label alone", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { calls, exec } = fakeHerdr(2);

	await syncHerdr(exec, "👀 #2725: HTTP 404");
	expect(calls.map(call => call.args.slice(0, 2).join(" "))).toEqual(["pane rename", "tab get"]);
});

test("no-ops outside herdr and reports a failure instead of throwing", async () => {
	const outside = fakeHerdr(1);
	expect(await syncHerdr(outside.exec, "🏁 #2725: HTTP 404")).toBeUndefined();
	expect(outside.calls).toEqual([]);

	Object.assign(process.env, HERDR_ENV);
	const failing = fakeHerdr(1, "pane rename");
	expect(await syncHerdr(failing.exec, "🏁 #2725: HTTP 404")).toBe("herdr sync failed: herdr pane rename: no such pane");
});

/**
 * A pi double carrying only what the mirror touches. Cast at the boundary
 * because ExtensionAPI is the runtime's full surface, not a test seam.
 */
function fakeMirrorPi(name: string | undefined, exec: unknown) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	const listeners: Array<() => void> = [];
	let unsubscribes = 0;
	const sessionManager = {
		onSessionNameChanged: (listener: () => void) => {
			listeners.push(listener);
			return () => {
				unsubscribes++;
			};
		},
	};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			handlers[event] = handler;
		},
		getSessionName: () => name,
		exec,
	};
	return {
		pi: pi as unknown as Parameters<typeof startTitleMirror>[0],
		emit: (event: string) => handlers[event]?.(undefined, { sessionManager }),
		rename: (next: string | undefined) => {
			name = next;
			for (const listener of listeners) listener();
		},
		get unsubscribes() {
			return unsubscribes;
		},
	};
}

/** `["pane <label>", "tab <label>"]` — what the herdr double was told to rename. */
const renames = (calls: ExecCall[]): string[] =>
	calls.filter(call => call.args[1] === "rename").map(call => `${call.args[0]} ${call.args[3]}`);

test("labels a tab from a session name nothing named a phase for", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { calls, exec } = fakeHerdr(1);
	const state: MirrorState = {};
	const harness = fakeMirrorPi("Fix: the DNSBL parser", exec);

	startTitleMirror(harness.pi, state);
	harness.emit("session_start");
	await state.synced;

	expect(renames(calls)).toEqual(["pane Fix: the DNSBL parser", "tab Fix: the DNSBL parser"]);
	expect(state.last).toBe("Fix: the DNSBL parser");
});

test("mirrors a later rename exactly once", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { calls, exec } = fakeHerdr(1);
	const state: MirrorState = {};
	const harness = fakeMirrorPi(undefined, exec);

	startTitleMirror(harness.pi, state);
	harness.emit("session_start");
	await state.synced;
	expect(calls).toEqual([]);

	harness.rename("🤔 #2879: control IPC");
	await state.synced;
	expect(renames(calls)).toEqual(["pane 🤔 #2879: control IPC", "tab 🤔 #2879: control IPC"]);

	harness.rename("🤔 #2879: control IPC");
	await state.synced;
	expect(renames(calls)).toEqual(["pane 🤔 #2879: control IPC", "tab 🤔 #2879: control IPC"]);
});

test("skips a title the tool already synced, and detaches on shutdown", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { calls, exec } = fakeHerdr(1);
	const state: MirrorState = { last: "🏗️ #2879: control IPC" };
	const harness = fakeMirrorPi("🏗️ #2879: control IPC", exec);

	startTitleMirror(harness.pi, state);
	harness.emit("session_start");
	harness.rename("🏗️ #2879: control IPC");
	await state.synced;
	expect(calls).toEqual([]);

	harness.emit("session_shutdown");
	expect(harness.unsubscribes).toBe(1);
});

test("reports an API error the CLI hid behind exit 0", async () => {
	Object.assign(process.env, HERDR_ENV);
	const { exec } = fakeHerdr(1, undefined, "pane rename");

	expect(await syncHerdr(exec, "🔬 #2725: HTTP 404")).toBe(
		"herdr sync failed: herdr pane rename: pane rename target missing",
	);
});

test("detects a leading phase emoji", () => {
	expect(hasPhaseMarker("🔬 #2725: HTTP 404")).toBe(true);
	expect(hasPhaseMarker("✅ done")).toBe(true);
	expect(hasPhaseMarker("fix the parser")).toBe(false);
	expect(hasPhaseMarker(undefined)).toBe(false);
});
