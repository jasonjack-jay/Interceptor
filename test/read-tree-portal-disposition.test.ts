/// <reference lib="dom" />

import { describe, expect, test, mock } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered */ }

// Follow-up to #106: lock the *corrected* out-of-flow disposition. The walker
// must descend into a zero-area box only when it is GENUINELY out-of-flow
// (CSS-removed from normal flow = position absolute / fixed). `position: sticky`
// is in-flow per CSS, so a zero-area sticky box must be pruned like any other
// in-flow collapsed element. Same happy-dom stub as read-tree-portal.test.ts:
// no layout engine, so isVisible() is faked to reject `data-zero-area` (as a
// real rect-based isVisible would for a 0×0 box).
mock.module("../extension/src/content/element-discovery", () => ({
  isVisible: (el: Element) => {
    if (!el.isConnected) return false
    let cur: Element | null = el
    while (cur) {
      const style = (cur as HTMLElement).style
      if (style?.display === "none" || style?.visibility === "hidden") return false
      cur = cur.parentElement
    }
    if (el.getAttribute("data-zero-area") === "true") return false
    return true
  },
  isInteractive: (el: Element) => {
    const tag = el.tagName
    if (tag === "BUTTON" || tag === "A" || tag === "INPUT") return true
    const role = el.getAttribute("role")
    return role === "menuitem" || role === "button"
  },
  INTERACTIVE_TAGS: new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"]),
  INTERACTIVE_ROLES: new Set(["button", "link", "menuitem"]),
  getShadowRoot: () => null,
}))

import { buildA11yTree } from "../extension/src/content/a11y-tree"

function makeRoot(html: string): Element {
  document.body.innerHTML = html
  return document.body
}

describe("buildA11yTree — out-of-flow disposition (absolute vs sticky)", () => {
  test("descends into a zero-area ABSOLUTE wrapper and emits its menuitems", () => {
    const root = makeRoot(`
      <div id="app"><button>App action</button></div>
      <div data-zero-area="true" style="position: absolute;">
        <div role="menu">
          <div role="menuitem">Absolute item A</div>
          <div role="menuitem">Absolute item B</div>
        </div>
      </div>
    `)
    const out = buildA11yTree(root, 0, 15, "interactive")
    expect(out).toContain("Absolute item A")
    expect(out).toContain("Absolute item B")
    expect(out).toContain("App action")
  })

  test("does NOT descend into a zero-area STICKY wrapper — sticky is in-flow", () => {
    const root = makeRoot(`
      <div id="app"><button>App action</button></div>
      <div data-zero-area="true" style="position: sticky;">
        <div role="menu">
          <div role="menuitem">Sticky should not appear</div>
        </div>
      </div>
    `)
    const out = buildA11yTree(root, 0, 15, "interactive")
    expect(out).toContain("App action")
    expect(out).not.toContain("Sticky should not appear")
  })
})
