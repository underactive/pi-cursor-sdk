/**
 * Simulates plan-mode execute: strips grep/find/ls/cursor on every turn_start. Cursor must not
 * re-add them; their replays route to inactive traces.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

export default function planStripShim(pi: ExtensionAPI): void {
	pi.on("turn_start", () => {
		pi.setActiveTools(NORMAL_MODE_TOOLS);
	});
}
