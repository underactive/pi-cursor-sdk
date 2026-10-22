import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	isNativeCursorToolName,
	NATIVE_CURSOR_TOOL_NAMES,
	type NativeCursorToolName,
} from "./cursor-native-tool-names.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import {
	isCursorNativeToolDisplayRequested,
	isCursorNativeToolRegistrationRequested,
	NATIVE_CURSOR_TOOL_DISPLAY_ENV,
	readBooleanEnv,
	getCursorNativeToolDisplayState,
	registerCursorNativeToolDisplayState,
	setCursorNativeToolDisplayRuntimeRequested,
} from "./cursor-native-tool-display-state.js";
import { isCursorReplayToolName } from "./cursor-tool-presentation-registry.js";
import { registerNativeCursorTool } from "./cursor-native-tool-display-tools.js";

export const CURSOR_CORE_PI_REPLAY_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const CORE_PI_TOOL_NAMES = new Set<string>(CURSOR_CORE_PI_REPLAY_TOOL_NAMES);

function isCursorCorePiReplayToolName(toolName: string): toolName is (typeof CURSOR_CORE_PI_REPLAY_TOOL_NAMES)[number] {
	return CORE_PI_TOOL_NAMES.has(toolName);
}

type CursorNativeToolActivationApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
type CursorNativeToolRegistryApi = CursorNativeToolActivationApi & Pick<ExtensionAPI, "getAllTools" | "registerTool">;

export type CursorNativeToolDisplayExtensionApi = CursorNativeToolRegistryApi
	& CursorModelLifecycleExtensionApi & Parameters<typeof registerCursorNativeToolDisplayState>[0];

// Pi filters getAllTools even after registration; new/reloaded extensions receive a new API.
const filteredRegistrations = new WeakMap<CursorNativeToolRegistryApi, Set<NativeCursorToolName>>();

// Pi has no owner for the active tool set, so Cursor changes it only when its own desired state flips
// (fresh session, model or mode change). Between those edges the loadout belongs to the user and other
// extensions, such as a read-only plan mode or the tool picker, and lifecycle syncs never reassert it.
interface NativeToolActivation {
	/** Desired state last applied; undefined until the first sync after session start. */
	applied: boolean | undefined;
	/** Pi restored or retained this session's loadout before session_start, so it is adopted as applied. */
	adoptLoadout: boolean;
}

const nativeToolActivations = new WeakMap<CursorNativeToolActivationApi, NativeToolActivation>();

function getNativeToolActivation(pi: CursorNativeToolActivationApi): NativeToolActivation {
	let activation = nativeToolActivations.get(pi);
	if (!activation) {
		activation = { applied: undefined, adoptLoadout: false };
		nativeToolActivations.set(pi, activation);
	}
	return activation;
}

function startNativeToolActivation(pi: CursorNativeToolActivationApi, event: SessionStartEvent, ctx: Pick<ExtensionContext, "sessionManager">): void {
	// Pi keeps the loadout across reload and restores a branch's recorded loadout before session_start.
	const adoptLoadout = event.reason === "reload" || ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	nativeToolActivations.set(pi, { applied: undefined, adoptLoadout });
}

function hasNonBuiltinTool(pi: Pick<ExtensionAPI, "getAllTools">, toolName: NativeCursorToolName): boolean {
	const existingTool = pi.getAllTools().find((tool) => tool.name === toolName);
	return existingTool !== undefined && existingTool.sourceInfo.source !== "builtin";
}

type NativeRegistrationContext = Pick<ExtensionContext, "mode" | "model"> & {
	ui: Pick<ExtensionContext["ui"], "notify">;
};

function registerNativeCursorToolsFromSet(
	pi: CursorNativeToolRegistryApi,
	toolNames: readonly NativeCursorToolName[],
	getCwd: () => string,
): NativeCursorToolName[] {
	const state = getCursorNativeToolDisplayState(pi);
	const { registeredNativeToolSources, skippedNativeToolNames } = state;
	let filteredToolNames = filteredRegistrations.get(pi);
	if (!filteredToolNames) {
		filteredToolNames = new Set();
		filteredRegistrations.set(pi, filteredToolNames);
	}
	const newlySkippedToolNames: NativeCursorToolName[] = [];
	for (const toolName of toolNames) {
		if (registeredNativeToolSources.has(toolName) || filteredToolNames.has(toolName)) continue;
		if (hasNonBuiltinTool(pi, toolName)) {
			if (!skippedNativeToolNames.has(toolName)) {
				skippedNativeToolNames.add(toolName);
				newlySkippedToolNames.push(toolName);
			}
			continue;
		}
		registerNativeCursorTool(pi, toolName, getCwd, state);
		const registeredTool = pi.getAllTools().find((tool) => tool.name === toolName);
		if (registeredTool) registeredNativeToolSources.set(toolName, registeredTool.sourceInfo);
		else filteredToolNames.add(toolName);
	}
	return newlySkippedToolNames;
}

function notifySkippedNativeCursorToolsIfNeeded(ctx: NativeRegistrationContext, skippedToolNames: readonly NativeCursorToolName[]): void {
	if (skippedToolNames.length === 0 || readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== true || ctx.mode !== "tui") return;
	ctx.ui.notify(
		`Cursor native tool replay skipped for ${skippedToolNames.join(", ")} because another extension already provides ${skippedToolNames.length === 1 ? "that tool" : "those tools"}. Cursor will use scrubbed activity transcripts for skipped tools.`,
		"warning",
	);
}

function removeRegisteredNonCoreNativeCursorTools(pi: CursorNativeToolActivationApi): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	if (registeredNativeToolSources.size === 0) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolSources.keys()) {
		if (isCursorCorePiReplayToolName(toolName)) continue;
		if (!activeToolNames.delete(toolName)) continue;
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

// Core pi tools are never added: Cursor only replaces their implementation and pi keeps their active
// state by name, so `bash`, `edit`, and `write` stay wherever the user or another extension left them.
function addRegisteredNonCoreNativeCursorTools(pi: CursorNativeToolActivationApi): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	if (registeredNativeToolSources.size === 0 || arePiToolsDisabled(pi)) return;
	const activeToolNames = new Set(pi.getActiveTools());
	let changed = false;
	for (const toolName of registeredNativeToolSources.keys()) {
		if (isCursorCorePiReplayToolName(toolName)) continue;
		if (isCursorReplayToolName(toolName) && !CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES.some((activeReplayToolName) => activeReplayToolName === toolName)) continue;
		if (activeToolNames.has(toolName)) continue;
		activeToolNames.add(toolName);
		changed = true;
	}
	if (changed) pi.setActiveTools([...activeToolNames]);
}

function syncRegisteredNativeCursorToolActivation(pi: CursorNativeToolActivationApi, desired: boolean): void {
	const activation = getNativeToolActivation(pi);
	// A fresh session starts with Cursor's tools off; an adopted loadout already reflects the desired state.
	const previous = activation.applied ?? (activation.adoptLoadout ? desired : false);
	activation.applied = desired;
	if (previous === desired) return;
	if (desired) addRegisteredNonCoreNativeCursorTools(pi);
	else removeRegisteredNonCoreNativeCursorTools(pi);
}

function ensureNativeCursorToolsRegisteredForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext, getCwd: () => string): void {
	if (!isCursorModel(ctx.model)) return;

	const nonCoreToolNames = NATIVE_CURSOR_TOOL_NAMES.filter((toolName) => !isCursorCorePiReplayToolName(toolName));
	const skippedToolNames = [
		...registerNativeCursorToolsFromSet(pi, nonCoreToolNames, getCwd),
		...registerNativeCursorToolsFromSet(pi, CURSOR_CORE_PI_REPLAY_TOOL_NAMES, getCwd),
	];
	notifySkippedNativeCursorToolsIfNeeded(ctx, skippedToolNames);
}

function ensureThenSyncNativeCursorToolsForModel(pi: CursorNativeToolRegistryApi, ctx: NativeRegistrationContext, getCwd: () => string): void {
	const { registeredNativeToolSources } = getCursorNativeToolDisplayState(pi);
	const currentTools = pi.getAllTools();
	for (const [toolName, sourceInfo] of registeredNativeToolSources) {
		if (!currentTools.some((tool) => tool.name === toolName && tool.sourceInfo === sourceInfo)) {
			registeredNativeToolSources.delete(toolName);
		}
	}
	const requested = isCursorNativeToolRegistrationRequested(ctx.mode);
	setCursorNativeToolDisplayRuntimeRequested(requested, pi);
	if (requested) ensureNativeCursorToolsRegisteredForModel(pi, ctx, getCwd);
	syncRegisteredNativeCursorToolActivation(pi, requested && isCursorModel(ctx.model));
}

export function registerCursorNativeToolDisplay(pi: CursorNativeToolDisplayExtensionApi): void {
	registerCursorNativeToolDisplayState(pi);
	let cwd = process.cwd();
	registerCursorModelLifecycle(pi, {
		sessionStart: (event, ctx) => {
			startNativeToolActivation(pi, event, ctx);
		},
		sync: (ctx) => {
			cwd = ctx.cwd;
			ensureThenSyncNativeCursorToolsForModel(pi, ctx, () => cwd);
		},
	});
}

export { isNativeCursorToolName, isCursorNativeToolDisplayRequested };
