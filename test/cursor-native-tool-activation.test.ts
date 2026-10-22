import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { beforeEach, expect, it } from "vitest";
import { getActiveContextToolNames } from "../src/cursor-context-tools.js";
import { registerCursorNativeToolDisplay } from "../src/cursor-native-tool-display-registration.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../src/cursor-native-tool-display-state.js";
import { makeAssistantMessage } from "./helpers/context-fixtures.js";
import { makeHarnessModel, makeModel, makeProviderModelConfig } from "./helpers/model-fixtures.js";
import { createPiHarness, type PiHarnessOptions } from "./helpers/pi-harness.js";

const MUTATING_TOOL_NAMES = ["bash", "edit", "write"];
const CURSOR_NATIVE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "cursor"];
// Read-only plan loadout in the shape of moa-fusion's enablePlanModeTools(): it keeps some Cursor
// wrappers (`read`, `grep`, `find`) and omits others (`ls`, `cursor`) plus every mutating tool.
const PLAN_TOOL_NAMES = ["read", "grep", "find", "write_plan", "exit_plan_mode"];

beforeEach(() => {
	delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
	nativeToolDisplayTestUtils.reset();
});

const sorted = (names: Iterable<string>) => [...names].sort();
const OTHER_MODEL = makeHarnessModel("openai-codex", "openai-codex-responses", "gpt-5.5");
const HISTORY: SessionEntry[] = [{
	type: "message", id: "user-1", parentId: null, timestamp: "2026-10-21T00:00:00.000Z",
	message: { role: "user", content: "earlier turn", timestamp: 1 },
}];

function createNativeToolPi(options: PiHarnessOptions = {}) {
	const pi = createPiHarness(options);
	registerCursorNativeToolDisplay(pi);
	return pi;
}

async function runCursorLifecycleSyncs(pi: ReturnType<typeof createNativeToolPi>) {
	await pi.runBeforeAgentStart();
	await pi.runTurnStart();
	// Switching between Cursor models is not a Cursor activation edge.
	await pi.runModelSelect(makeModel("gpt-5.5"));
}

it("activates optional Cursor tools on a fresh session without adding omitted core pi tools", async () => {
	const pi = createNativeToolPi({ activeTools: ["read"] });
	await pi.runSessionStart();

	expect(sorted(pi._activeToolNames())).toEqual(["cursor", "find", "grep", "ls", "read"]);
});

it("keeps a plan-like read-only subset and a picker removal through later Cursor syncs", async () => {
	const pi = createNativeToolPi();
	await pi.runSessionStart();
	expect(sorted(pi._activeToolNames())).toEqual(sorted(["read", "bash", "edit", "write", "grep", "find", "ls", "cursor"]));

	pi.setActiveTools(["read", "grep", "write_plan"]);
	await runCursorLifecycleSyncs(pi);
	expect(pi._activeToolNames()).toEqual(["read", "grep", "write_plan"]);

	pi.setActiveTools(["read", "bash", "edit", "write", "find", "ls", "cursor"]);
	await runCursorLifecycleSyncs(pi);
	expect(pi._activeToolNames()).toEqual(["read", "bash", "edit", "write", "find", "ls", "cursor"]);
});

it.each([
	{ label: "resume with history", reason: "resume" as const, branch: HISTORY },
	{ label: "startup with history", reason: "startup" as const, branch: HISTORY },
	{ label: "reload", reason: "reload" as const, branch: [] },
])("adopts the loadout Pi restored or retained on $label", async ({ reason, branch }) => {
	const pi = createNativeToolPi({ activeTools: ["read", "grep", "write_plan"] });
	await pi.runSessionStart({ sessionManager: { getBranch: () => branch } }, { reason });
	await runCursorLifecycleSyncs(pi);

	expect(pi._activeToolNames()).toEqual(["read", "grep", "write_plan"]);
});

it("removes optional Cursor tools on a non-Cursor model and restores them on return", async () => {
	const pi = createNativeToolPi();
	await pi.runSessionStart({ sessionManager: { getBranch: () => HISTORY } }, { reason: "resume" });
	expect(pi._activeToolNames()).toEqual(["read", "bash", "edit", "write"]);

	await pi.runModelSelect(OTHER_MODEL);
	await pi.runModelSelect(makeModel("composer-2.5"));
	expect(sorted(pi._activeToolNames())).toEqual(sorted(["read", "bash", "edit", "write", "grep", "find", "ls", "cursor"]));

	await pi.runModelSelect(OTHER_MODEL);
	expect(pi._activeToolNames()).toEqual(["read", "bash", "edit", "write"]);
	// Leaving Cursor is one edge: a tool the user enables for the other model is not stripped again.
	pi.setActiveTools(["read", "bash", "edit", "write", "grep"]);
	await pi.runTurnStart({ model: OTHER_MODEL });
	expect(pi._activeToolNames()).toEqual(["read", "bash", "edit", "write", "grep"]);
});

it.each([
	{ order: "cursor-first", repairsBeforeAgentStart: false },
	{ order: "cursor-first", repairsBeforeAgentStart: true },
	{ order: "plan-first", repairsBeforeAgentStart: false },
	{ order: "plan-first", repairsBeforeAgentStart: true },
] as const)("keeps another extension's read-only plan loadout across Cursor lifecycle syncs ($order, repairs on before_agent_start: $repairsBeforeAgentStart)", async ({ order, repairsBeforeAgentStart }) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-native-activation-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const dir of [agentDir, sessionDir]) mkdirSync(dir);
	const model = makeModel("offline");
	const extensionErrors: unknown[] = [];
	const requestToolNames: string[][] = [];

	function cursor(api: ExtensionAPI) {
		api.registerProvider("cursor", {
			api: "cursor-sdk", baseUrl: "http://unused.invalid", apiKey: "offline-test-only",
			models: [makeProviderModelConfig(model.id)],
			streamSimple(selectedModel, context) {
				// The provider's request snapshot is what Cursor replay routing and the pi bridge consume.
				requestToolNames.push(sorted(getActiveContextToolNames(context) ?? []));
				const message = { ...makeAssistantMessage("OK"), model: selectedModel.id };
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				});
				return stream;
			},
		});
		registerCursorNativeToolDisplay(api);
	}

	// Plan state belongs to the session file, so resume re-enters plan mode like a persisted plan extension.
	const savedNormalTools = new Map<string, string[]>();
	let planApi: ExtensionAPI | undefined;
	function planMode(api: ExtensionAPI) {
		planApi = api;
		for (const name of ["write_plan", "exit_plan_mode"]) {
			api.registerTool({
				name, label: name, description: name, parameters: Type.Object({}), defaultActive: false,
				async execute() {
					return { content: [{ type: "text", text: name }], details: undefined };
				},
			});
		}
		api.on("session_start", (_event, ctx) => {
			if (savedNormalTools.has(ctx.sessionManager.getSessionFile() ?? "")) api.setActiveTools(PLAN_TOOL_NAMES);
		});
		if (repairsBeforeAgentStart) {
			api.on("before_agent_start", (_event, ctx) => {
				if (savedNormalTools.has(ctx.sessionManager.getSessionFile() ?? "")) api.setActiveTools(PLAN_TOOL_NAMES);
			});
		}
	}
	function enterPlanMode(session: AgentSession) {
		savedNormalTools.set(session.sessionManager.getSessionFile()!, planApi!.getActiveTools());
		planApi!.setActiveTools(PLAN_TOOL_NAMES);
	}
	function exitPlanMode(session: AgentSession) {
		const file = session.sessionManager.getSessionFile()!;
		planApi!.setActiveTools(savedNormalTools.get(file)!);
		savedNormalTools.delete(file);
	}

	const factories: ExtensionFactory[] = order === "cursor-first" ? [cursor, planMode] : [planMode, cursor];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false }),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: factories,
			},
		});
		const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
		expect(result.extensionsResult.errors).toEqual([]);
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: root, agentDir, sessionManager: SessionManager.create(root, sessionDir),
	});
	const bind = (session: AgentSession) => session.bindExtensions({ mode: "json", onError: error => extensionErrors.push(error) });
	runtime.setRebindSession(bind);
	async function promptAndReadRequestTools(text: string): Promise<string[]> {
		await runtime.session.prompt(text);
		const requestTools = requestToolNames.at(-1)!;
		// The live loadout after the run matches what the request declared.
		expect(sorted(runtime.session.getActiveToolNames())).toEqual(requestTools);
		return requestTools;
	}

	try {
		await bind(runtime.session);

		// Ordinary Cursor mode still activates every Cursor native tool.
		const ordinaryTools = await promptAndReadRequestTools("Ordinary turn");
		expect(ordinaryTools).toEqual(sorted(CURSOR_NATIVE_TOOL_NAMES));
		const planFile = runtime.session.sessionManager.getSessionFile()!;

		// A read-only plan loadout applied between turns stays exact through Cursor's
		// before_agent_start and turn_start syncs, in either handler order.
		enterPlanMode(runtime.session);
		expect(await promptAndReadRequestTools("First plan turn")).toEqual(sorted(PLAN_TOOL_NAMES));
		expect(await promptAndReadRequestTools("Second plan turn")).toEqual(sorted(PLAN_TOOL_NAMES));

		// Reload keeps the plan loadout instead of restoring Cursor's tools.
		await runtime.session.reload();
		const reloadTools = await promptAndReadRequestTools("Plan turn after reload");
		expect(reloadTools).toEqual(expect.arrayContaining(PLAN_TOOL_NAMES));
		for (const name of MUTATING_TOOL_NAMES) expect(reloadTools).not.toContain(name);

		// Resume restores the recorded plan loadout before session_start; Cursor must not widen it.
		expect(await runtime.newSession()).toEqual({ cancelled: false });
		expect(await promptAndReadRequestTools("Ordinary turn in another session")).toEqual(sorted(CURSOR_NATIVE_TOOL_NAMES));
		expect(await runtime.switchSession(planFile)).toEqual({ cancelled: false });
		const resumedTools = await promptAndReadRequestTools("Plan turn after resume");
		expect(resumedTools).toEqual(expect.arrayContaining(PLAN_TOOL_NAMES));
		for (const name of MUTATING_TOOL_NAMES) expect(resumedTools).not.toContain(name);
		// Pi itself activates Cursor's late-registered `cursor` replay tool on a new binding; an
		// extension that repairs its loadout on before_agent_start then keeps it exact.
		if (repairsBeforeAgentStart) expect(resumedTools).toEqual(sorted(PLAN_TOOL_NAMES));

		// Leaving plan mode restores the user's ordinary loadout, including Cursor's native tools.
		exitPlanMode(runtime.session);
		expect(await promptAndReadRequestTools("Ordinary turn after plan")).toEqual(sorted(CURSOR_NATIVE_TOOL_NAMES));
		expect(extensionErrors).toEqual([]);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
