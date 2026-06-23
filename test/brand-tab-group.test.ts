import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  normalizeColor,
  normalizeBrandTabGroup,
  DEFAULT_TAB_GROUP_TITLE,
  DEFAULT_TAB_GROUP_COLOR,
} from "../extension/src/background/brand-tab-group"

// The accessor module is module-load side-effect-free, so it imports cleanly under bun (no `chrome`
// global needed) and its pure validators are unit-testable here.

describe("brand-tab-group: color validation", () => {
  test("every valid Chrome tabGroups color passes through", () => {
    for (const c of ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const) {
      expect(normalizeColor(c)).toBe(c)
    }
  })

  test("an invalid color falls back to cyan (never throws)", () => {
    expect(normalizeColor("teal")).toBe("cyan")
    expect(normalizeColor("")).toBe("cyan")
    expect(normalizeColor(undefined)).toBe("cyan")
    expect(normalizeColor(null)).toBe("cyan")
    expect(normalizeColor(123)).toBe("cyan")
  })
})

describe("brand-tab-group: value normalization + default fallback", () => {
  test("empty / missing / blank raw resolves to the built-in default", () => {
    expect(normalizeBrandTabGroup(undefined)).toEqual({
      title: DEFAULT_TAB_GROUP_TITLE,
      color: DEFAULT_TAB_GROUP_COLOR,
    })
    expect(normalizeBrandTabGroup({})).toEqual({ title: "interceptor", color: "cyan" })
    expect(normalizeBrandTabGroup({ title: "   " })).toEqual({ title: "interceptor", color: "cyan" })
  })

  test("valid raw passes through; an invalid color clamps to cyan", () => {
    expect(normalizeBrandTabGroup({ title: "Acme", color: "blue" })).toEqual({ title: "Acme", color: "blue" })
    expect(normalizeBrandTabGroup({ title: "Acme", color: "teal" })).toEqual({ title: "Acme", color: "cyan" })
  })

  test("the default is exactly today's behavior (interceptor / cyan)", () => {
    expect(DEFAULT_TAB_GROUP_TITLE).toBe("interceptor")
    expect(DEFAULT_TAB_GROUP_COLOR).toBe("cyan")
  })
})

describe("tab-group.ts uses the runtime accessors (not frozen literals)", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "extension", "src", "background", "tab-group.ts"),
    "utf-8",
  )

  test("the group create path calls getTabGroupTitle()/getTabGroupColor()", () => {
    expect(src).toContain("getTabGroupTitle()")
    expect(src).toContain("getTabGroupColor()")
  })

  test('the hardcoded { title: "interceptor", color: "cyan" } update literal is gone', () => {
    expect(src).not.toMatch(/title:\s*"interceptor"\s*,\s*color:\s*"cyan"/)
  })

  test("the re-discovery query uses the candidate title set, not a single hardcoded title", () => {
    expect(src).toContain("getCandidateTitles()")
    expect(src).not.toContain('chrome.tabGroups.query({ title: "interceptor" })')
  })
})
