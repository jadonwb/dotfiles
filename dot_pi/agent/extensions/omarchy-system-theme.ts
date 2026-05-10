/**
 * Syncs pi's theme with the active Omarchy theme.
 *
 * Prefers the theme named in:
 *   ~/.config/omarchy/current/theme.name
 *
 * Falls back to Omarchy light/dark mode:
 *   ~/.config/omarchy/current/theme/light.mode
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const home = process.env.HOME ?? "";
const lightModePath = join(home, ".config/omarchy/current/theme/light.mode");
const themeNamePath = join(home, ".config/omarchy/current/theme.name");

function getFallbackTheme(): "light" | "dark" {
	return existsSync(lightModePath) ? "light" : "dark";
}

function getNamedOmarchyTheme(ctx: ExtensionContext): string | undefined {
	if (!existsSync(themeNamePath)) {
		return undefined;
	}

	try {
		const name = readFileSync(themeNamePath, "utf-8").trim();
		if (!name) {
			return undefined;
		}
		return ctx.ui.getTheme(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

function getOmarchyPiTheme(ctx: ExtensionContext): string {
	return getNamedOmarchyTheme(ctx) ?? getFallbackTheme();
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", (_event, ctx) => {
		let currentTheme = getOmarchyPiTheme(ctx);
		ctx.ui.setTheme(currentTheme);

		intervalId = setInterval(() => {
			const nextTheme = getOmarchyPiTheme(ctx);
			if (nextTheme !== currentTheme) {
				currentTheme = nextTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, 2000);
	});

	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
