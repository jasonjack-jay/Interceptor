/**
 * cli/commands/brand.ts — runtime white-label of the Chrome tab-group identity.
 *
 *   interceptor brand tab-group --title "Acme" [--color blue]
 *
 * Emits a no-tab `brand_set_tab_group` action; the daemon relays it to the extension, which writes
 * `chrome.storage.local.brandTabGroup` and live-retitles the group. No rebuild, no options page.
 */

type Action = { type: string; [key: string]: unknown }

// Closed Chrome tabGroups color enum — validated CLI-side (fail fast) as well as in the extension.
const VALID_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export function parseBrandCommand(filtered: string[]): Action {
  const sub = filtered[1]
  if (sub !== "tab-group") {
    console.error('error: usage: interceptor brand tab-group --title <label> [--color <color>]')
    process.exit(1)
  }

  const title = flagVal(filtered, "--title")
  if (!title || title.startsWith("--")) {
    console.error("error: interceptor brand tab-group requires --title <label>")
    process.exit(1)
  }

  const color = flagVal(filtered, "--color") ?? "cyan"
  if (!VALID_COLORS.includes(color)) {
    console.error(`error: invalid --color '${color}' (must be one of: ${VALID_COLORS.join(", ")})`)
    process.exit(1)
  }

  return { type: "brand_set_tab_group", title, color }
}
