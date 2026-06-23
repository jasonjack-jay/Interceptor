/// <reference lib="dom" />

import { describe, expect, test, mock } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* already registered */ }

// happy-dom has no layout engine, so the real isVisible() (which inspects
// getBoundingClientRect / offsetParent) can't run here. This stub reproduces
// the exact production failure mode we are fixing: a portal / popper wrapper
// that is laid out at `position:fixed` but reports a zero-area box for a frame
// before Floating UI positions it. We mark such a wrapper with
// `data-zero-area` and have isVisible() return false for it — just as the real
// rect-based isVisible() would during that frame.
mock.module("../extension/src/content/element-discovery", () => ({
  isVisible: (el: Element) => {
    if (!el.isConnected) return false
    let cur: Element | null = el
    while (cur) {
      const style = (cur as HTMLElement).style
      if (style?.display === "none" || style?.visibility === "hidden") return false
      cur = cur.parentElement
    }
    // Simulate a zero-area box (real isVisible would reject rect 0x0).
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

describe("buildA11yTree — portal / out-of-flow visibility", () => {
  test("descends into a zero-area FIXED portal wrapper and emits its menuitems", () => {
    // Mirrors a Radix DropdownMenu: the popper wrapper is position:fixed and,
    // for the first frame, reports a 0x0 box (data-zero-area). Its menu items
    // are fully real. The old walker bailed at the wrapper and dropped them.
    const root = makeRoot(`
      <div id="app"><button>App action</button></div>
      <div data-zero-area="true" style="position: fixed;">
        <div role="menu">
          <div role="menuitem">Impersonate</div>
          <div role="menuitem">Set plan</div>
          <div role="menuitem">Pending invitations</div>
        </div>
      </div>
    `)
    const out = buildA11yTree(root, 0, 15, "interactive")
    expect(out).toContain("Impersonate")
    expect(out).toContain("Set plan")
    expect(out).toContain("Pending invitations")
    // The invisible wrapper itself is not emitted (it is not interactive and
    // not visible), only its visible descendants.
    expect(out).toContain("App action")
  })

  test("does NOT descend into an in-flow (static) invisible wrapper — no bloat regression", () => {
    // A collapsed / empty in-flow container that reports zero area must still be
    // pruned, so we don't surface hidden in-flow content (accordions, etc.).
    const root = makeRoot(`
      <div id="app"><button>Visible button</button></div>
      <div data-zero-area="true">
        <button>Hidden in-flow button</button>
      </div>
    `)
    const out = buildA11yTree(root, 0, 15, "interactive")
    expect(out).toContain("Visible button")
    expect(out).not.toContain("Hidden in-flow button")
  })

  test("display:none stops the subtree even when out-of-flow", () => {
    const root = makeRoot(`
      <div id="app"><button>Shown</button></div>
      <div data-zero-area="true" style="position: fixed; display: none;">
        <div role="menuitem">Should not appear</div>
      </div>
    `)
    const out = buildA11yTree(root, 0, 15, "interactive")
    expect(out).toContain("Shown")
    expect(out).not.toContain("Should not appear")
  })
})
