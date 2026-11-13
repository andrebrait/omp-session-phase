import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Agent-driven session renaming: one tool the model calls when work starts and
// on every phase/status change, so the session name tracks the task instead of
// freezing on the first prompt's auto-title.
//
// Format: `<emoji> <ref>: <slug>` — e.g. `🔬 #2725: HTTP 404`. The emoji is the
// phase (repo status-marker convention), the ref is the ticket, the slug is the
// subject. `ref`/`slug` are optional on later calls: they are recovered from the
// current name, so a phase move is a one-argument call.
//
// `setSessionName` fires the session-name listeners, so the terminal title and
// the title-derived session accent color follow along, and the title is mirrored
// onto the Herdr pane/tab label when running inside Herdr. The same listener is
// what labels a tab whose seat never calls this tool: any rename — including the
// auto-generated first-prompt title — reaches Herdr, so a tab shows its task
// instead of its number.

const PHASE_EMOJI: Record<string, string> = {
	triage: "🔬",
	investigate: "🤔",
	plan: "📝",
	implement: "🏗️",
	fix: "🛠️",
	test: "🧪",
	review: "👀",
	ci: "⏳",
	waiting: "⏸️",
	question: "❓",
	blocked: "🚧",
	landing: "🏁",
	done: "✅",
};

const PHASES = Object.keys(PHASE_EMOJI) as [string, ...string[]];
const PHASE_VALUES = Object.values(PHASE_EMOJI);

/** True when the name already leads with a phase emoji. */
export const hasPhaseMarker = (name: string | undefined): boolean =>
	PHASE_VALUES.some(emoji => name?.startsWith(emoji));

// Leading phase emoji, then an optional ref token (must contain a digit, so
// prose like "Fix: the parser" is not mistaken for one), then the slug.
const TITLE_RE = /^(?:(?:\p{Extended_Pictographic}\uFE0F?)+\s+)?(?:(#?[\w.\-/]*\d[\w.\-/]*):\s+)?(.*)$/u;

const REF_PREFIX_RE = /^(?:issue|issues|pr|prs|gh)[:/#-]?/i;

const clean = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** `2725`, `#2725`, `issue:2725` -> `#2725`; `ADR-42` -> `ADR-42`. */
export function normalizeRef(ref: string | undefined): string | undefined {
	const token = clean(ref ?? "", 24).replace(REF_PREFIX_RE, "").replace(/^#/, "");
	if (!token) return undefined;
	return /^\d+$/.test(token) ? `#${token}` : clean(token, 16);
}

export function parseTitle(name: string | undefined): { ref?: string; slug?: string } {
	const match = TITLE_RE.exec(name ?? "");
	return { ref: match?.[1], slug: match?.[2]?.trim() || undefined };
}

export function composeTitle(
	phase: string,
	fields: { ref?: string; slug?: string },
	current: string | undefined,
): string {
	const inherited = parseTitle(current);
	const ref = normalizeRef(fields.ref) ?? inherited.ref;
	const slug = clean(fields.slug ?? "", 44) || inherited.slug || phase;
	const emoji = PHASE_EMOJI[phase] ?? PHASE_EMOJI.implement;
	return `${emoji} ${ref ? `${ref}: ` : ""}${slug}`;
}

/**
 * Mirror the title onto the Herdr pane (and the tab when this pane is its only
 * one, so a shared tab keeps its own label). Same CLI surface and pane-count
 * guard as `@henryqw/pi-herdr-rename`; workspace and git-branch renaming are
 * deliberately left out — worktrees and branches are owned by the repository's
 * own tooling, not by a session title. No-op outside Herdr.
 */
export async function syncHerdr(
	exec: ExtensionAPI["exec"],
	title: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const paneId = process.env.HERDR_PANE_ID;
	const tabId = process.env.HERDR_TAB_ID;
	if (process.env.HERDR_ENV !== "1" || !paneId) return undefined;
	const herdr = process.env.HERDR_BIN_PATH || "herdr";
	const options = { signal, timeout: 2_000 };

	const run = async (args: string[]): Promise<string> => {
		const result = await exec(herdr, args, options);
		if (result.code !== 0 || result.killed) {
			throw new Error(`herdr ${args[0]} ${args[1]}: ${result.stderr.trim() || `exit ${result.code}`}`);
		}
		// The CLI reports an API error in its payload and still exits 0, so an
		// unread `{"error":…}` would pass for a successful rename.
		const failure = /"error":\s*\{[^}]*"message":\s*"([^"]*)"/.exec(result.stdout);
		if (failure) throw new Error(`herdr ${args[0]} ${args[1]}: ${failure[1]}`);
		return result.stdout;
	};

	try {
		await run(["pane", "rename", paneId, title]);
		if (!tabId) return undefined;
		const tab = JSON.parse(await run(["tab", "get", tabId])) as { result?: { tab?: { pane_count?: number } } };
		if (tab.result?.tab?.pane_count === 1) await run(["tab", "rename", tabId, title]);
	} catch (error) {
		return `herdr sync failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}

/**
 * What the mirror has already pushed to Herdr, so one rename is synced once,
 * and the tail of the sync chain so renames land in the order they happened.
 */
export type MirrorState = { last?: string; synced?: Promise<unknown> };

/** The slice of the hook context the mirror needs: the session-name signal. */
type NameChangeContext = {
	sessionManager?: { onSessionNameChanged?: (listener: () => void) => () => void };
};

/**
 * Mirror EVERY session rename onto Herdr, not just the ones this tool makes:
 * `session_phase` is agent-driven, so a seat that never calls it (or has not
 * called it yet) would otherwise sit under Herdr's default tab number. The
 * session manager's name signal is the exact seam — it fires for the
 * auto-generated first-prompt title, a `/name` rename, and this tool alike, so
 * no polling or turn-boundary guessing is involved. Re-attached on every
 * session start/switch because each carries its own session manager.
 */
export function startTitleMirror(pi: ExtensionAPI, state: MirrorState): void {
	let unsubscribe: (() => void) | undefined;

	const mirror = (): void => {
		const name = pi.getSessionName();
		if (!name || name === state.last) return;
		state.last = name;
		// Chained, never parallel: two quick renames must not race each other to
		// the label. `state.synced` is also what a caller awaits for the tail.
		state.synced = Promise.resolve(state.synced).then(() => syncHerdr(pi.exec.bind(pi), name));
	};

	const attach = (ctx: NameChangeContext | undefined): void => {
		unsubscribe?.();
		unsubscribe = ctx?.sessionManager?.onSessionNameChanged?.(mirror);
		mirror();
	};

	pi.on("session_start", (_event, ctx) => attach(ctx));
	pi.on("session_switch", (_event, ctx) => attach(ctx));
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}

export default function sessionPhase(pi: ExtensionAPI): void {
	const z = pi.zod;
	const mirrored: MirrorState = {};
	let phaseCalled = false;
	let settledTurns = 0;

	startTitleMirror(pi, mirrored);

	// The tool is model-discretion, so a seat that never calls it would freeze
	// under a plain auto-title. Two backstops make the decoration unskippable:
	// from the second settled turn on, nudge the model to claim the phase, and
	// at the end of each settled turn, rename an unclaimed auto-title to
	// `🔬 <title>`. A user-chosen name (titleSource "user") is never touched.
	pi.on("session_start", () => {
		phaseCalled = false;
		settledTurns = 0;
	});
	pi.on("session_switch", () => {
		phaseCalled = false;
		settledTurns = 0;
	});
	pi.on("before_agent_start", () => {
		if (phaseCalled || settledTurns === 0) return;
		return {
			message: {
				customType: "session-phase-nudge",
				content:
					"Session phase reminder: if this session is doing substantive work, call the " +
					"`session_phase` tool now with the phase it is in (plus ref/slug if not set yet). " +
					"Ignore this for a pure chat turn.",
				display: false,
				attribution: "agent",
			},
		};
	});
	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		settledTurns += 1;
		if (phaseCalled) return;
		const name = pi.getSessionName();
		if (name && (hasPhaseMarker(name) || (ctx.sessionManager as { titleSource?: string }).titleSource === "user")) return;
		// The slug is the existing (auto) title, or the first user message when
		// the session is still untitled (print mode, title generator down).
		const firstUserText = (messages: typeof event.messages): string => {
			for (const message of messages) {
				const content = (message as { role?: string; content?: string | Array<{ type?: string; text?: string }> }).content;
				if ((message as { role?: string }).role !== "user") continue;
				if (typeof content === "string") return content;
				if (Array.isArray(content))
					return content.filter(c => c.type === "text" && c.text).map(c => c.text ?? "").join(" ");
			}
			return "";
		};
		const slug = clean(name ?? firstUserText(event.messages), 44);
		if (!slug) return;
		const title = `${PHASE_EMOJI.triage} ${slug}`;
		// Claim the sync before the rename fires the mirror's listener, same as
		// the tool path, so one Herdr call reports one rename.
		mirrored.last = title;
		await pi.setSessionName(title);
		await syncHerdr(pi.exec.bind(pi), title);
	});

	pi.registerTool({
		name: "session_phase",
		label: "Session Phase",
		loadMode: "essential",
		description: [
			"Rename the current session to reflect the active phase or status.",
			"Renders as `<emoji> <ref>: <slug>` (e.g. `🔬 #2725: HTTP 404`).",
			"Call it when work on a ticket/task starts, on every phase change, and when",
			"the session goes to a waiting/question/blocked status. Pass `ref`/`slug` on",
			"the first call; omit them later to keep the current ones.",
		].join(" "),
		parameters: z.object({
			phase: z.enum(PHASES).describe(
				"triage=🔬 investigate=🤔 plan=📝 implement=🏗️ fix=🛠️ test=🧪 review=👀 " +
					"ci=⏳ (awaiting CI) waiting=⏸️ (blocked on something external) question=❓ " +
					"(awaiting a user answer) blocked=🚧 landing=🏁 done=✅",
			),
			ref: z
				.string()
				.optional()
				.describe("Ticket reference: issue/PR number (`2725`, `#2725`) or an id like `ADR-42`."),
			slug: z
				.string()
				.optional()
				.describe("Short subject, a few words — the topic, not the phase (e.g. `HTTP 404`)."),
		}),
		async execute(_toolCallId, params, signal) {
			phaseCalled = true;
			const title = composeTitle(params.phase, params, pi.getSessionName());
			// Claim the sync before the rename fires the mirror's listener, so the
			// tool reports the one Herdr call instead of racing a duplicate.
			mirrored.last = title;
			await pi.setSessionName(title);
			const warning = await syncHerdr(pi.exec.bind(pi), title, signal);
			return {
				content: [{ type: "text", text: warning ? `${title}\n${warning}` : title }],
				details: { title, warning },
			};
		},
	});
}
