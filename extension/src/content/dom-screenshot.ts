// dom-screenshot.ts
//
// Content-script handler for the DOM-render screenshot pipeline.
// Driven by `case "dom_screenshot":` in content.ts.
//
// Native renderer — no external library. The browser already exposes every
// primitive a DOM→image library wraps: getComputedStyle, cloneNode,
// XMLSerializer, <svg><foreignObject>, Image/decode, Canvas, FileReader and
// fetch. We inline computed styles, embed <img>/<canvas>/background-image
// resources as data URLs, serialize the clone into a foreignObject SVG,
// rasterize it to a canvas and read it back. Every step runs unthrottled on a
// backgrounded (hidden) tab — unlike requestAnimationFrame (suspended when
// hidden) and unlike html-to-image's per-node overhead, which made large/
// SVG-heavy pages time out on background tabs.
//
// Pre-condition: the CORS DNR session rule installed by the SW must be active so
// third-party <img>/background-image fetches return Access-Control-Allow-Origin:
// "*" and can be embedded as data URLs without tainting the canvas.

import { resolveElement } from "./input-simulation"

type ActionResult = { success: boolean; error?: string; data?: unknown }

type DomScreenshotAction = {
  type: string
  mode?: "full" | "element" | "selector" | "region"
  ref?: string
  index?: number
  selector?: string
  region?: { x: number; y: number; width: number; height: number }
  format?: "png" | "jpeg"
  quality?: number
  scale?: number
  target_max_long_edge?: number
}

// 1×1 transparent PNG — placeholder for any resource we can't fetch CORS-clean,
// so the canvas never taints and toDataURL() never throws.
const TRANSPARENT_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=="

const SKIP_TAGS = new Set(["script", "noscript", "style", "link", "meta", "template", "iframe", "object", "embed"])

type CloneCollect = {
  imgJobs: Array<{ el: HTMLElement; url: string }>
  bgJobs: Array<{ el: HTMLElement; value: string }>
  urls: Set<string>
}

function extractUrls(cssValue: string): string[] {
  const out: string[] = []
  const re = /url\((['"]?)([^'")]+)\1\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cssValue)) !== null) {
    const u = (m[2] || "").trim()
    if (u && u.indexOf("data:") !== 0) out.push(u)
  }
  return out
}

async function fetchResourceAsDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, { mode: "cors", cache: "force-cache" })
    if (!res.ok) return TRANSPARENT_1PX
    const blob = await res.blob()
    return await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : TRANSPARENT_1PX)
      reader.onerror = () => resolve(TRANSPARENT_1PX)
      reader.readAsDataURL(blob)
    })
  } catch {
    return TRANSPARENT_1PX
  }
}

// Load an SVG data URL into an Image. Resolve after decode() (NOT inside
// requestAnimationFrame — rAF is suspended on hidden tabs); decode() is not
// throttled by visibility.
function loadSvgImage(svgDataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      img.decode().then(() => resolve(img)).catch(() => resolve(img))
    }
    img.onerror = () => reject(new Error("foreignObject SVG failed to rasterize"))
    img.src = svgDataUrl
  })
}

function inlineComputedStyle(srcEl: Element, cloneEl: HTMLElement, collect: CloneCollect): void {
  const cs = window.getComputedStyle(srcEl)
  let cssText = ""
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]
    let value = cs.getPropertyValue(name)
    // Shrink font-size by 0.1px so re-layout inside the foreignObject doesn't
    // clip the last line/character (html-to-image uses the same nudge).
    if (name === "font-size" && value.endsWith("px")) {
      const n = parseFloat(value)
      if (n > 0) value = `${n - 0.1}px`
    }
    cssText += `${name}:${value};`
  }
  try { cloneEl.style.cssText = cssText } catch { /* a few elements reject bulk cssText */ }
  const bg = cs.getPropertyValue("background-image")
  if (bg && bg.indexOf("url(") !== -1) {
    collect.bgJobs.push({ el: cloneEl, value: bg })
    for (const u of extractUrls(bg)) collect.urls.add(u)
  }
}

function buildStyledClone(src: Node, collect: CloneCollect): Node | null {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode(false)
  if (src.nodeType !== Node.ELEMENT_NODE) return null
  const el = src as Element
  const tag = (el.tagName || "").toLowerCase()
  if (SKIP_TAGS.has(tag)) return null

  // <canvas> clones blank — snapshot its pixels into an <img> instead.
  if (tag === "canvas") {
    try {
      const dataUrl = (el as HTMLCanvasElement).toDataURL()
      const img = document.createElement("img")
      img.setAttribute("src", dataUrl)
      inlineComputedStyle(el, img, collect)
      return img
    } catch { /* tainted canvas — fall through to a (blank) structural clone */ }
  }

  // Inline <svg> renders from its own structure/attributes. Deep-clone it
  // wholesale (cheap, native) and inline only the root's computed style — its
  // descendants inherit `color` (so currentColor icons keep their colour).
  // Skipping per-descendant style inlining is the key win on SVG-heavy pages
  // (e.g. Wikipedia ships ~2.6k inline icons), where html-to-image's per-node
  // work made the whole render time out on background tabs.
  if (tag === "svg") {
    const c = el.cloneNode(true) as HTMLElement
    try { inlineComputedStyle(el, c, collect) } catch { /* SVGAnimatedString style quirks */ }
    return c
  }

  const c = el.cloneNode(false) as HTMLElement
  if (c.style) inlineComputedStyle(el, c, collect)

  if (tag === "img") {
    const im = el as HTMLImageElement
    const url = im.currentSrc || im.src
    if (url && url.indexOf("data:") !== 0) {
      c.removeAttribute("srcset")
      collect.imgJobs.push({ el: c, url })
      collect.urls.add(url)
    }
  }

  const kids = el.childNodes
  for (let i = 0; i < kids.length; i++) {
    const cc = buildStyledClone(kids[i], collect)
    if (cc) c.appendChild(cc)
  }
  return c
}

async function nativeRenderToDataUrl(
  node: HTMLElement,
  o: { width: number; height: number; pixelRatio: number; format: "png" | "jpeg"; quality: number; isFull: boolean }
): Promise<string> {
  const collect: CloneCollect = { imgJobs: [], bgJobs: [], urls: new Set() }
  const clone = buildStyledClone(node, collect) as HTMLElement | null
  if (!clone) throw new Error("nothing to render")

  // Fetch every referenced resource once, in parallel, CORS-clean (the SW's DNR
  // rule adds ACAO:* for the capture). Failures become the transparent
  // placeholder so the canvas never taints.
  const urlList = Array.from(collect.urls)
  const dataUrlMap = new Map<string, string>()
  await Promise.all(urlList.map(async (u) => { dataUrlMap.set(u, await fetchResourceAsDataUrl(u)) }))

  for (const job of collect.imgJobs) {
    job.el.setAttribute("src", dataUrlMap.get(job.url) || TRANSPARENT_1PX)
  }
  for (const job of collect.bgJobs) {
    let v = job.value
    for (const u of extractUrls(job.value)) {
      const d = dataUrlMap.get(u)
      if (d) v = v.split(u).join(d)
    }
    try { job.el.style.backgroundImage = v } catch { /* ignore */ }
  }

  if (o.isFull) {
    // Force the root box to the full document scroll size so the whole page
    // lays out inside the foreignObject (not just the viewport slice).
    clone.style.width = `${o.width}px`
    clone.style.height = `${o.height}px`
  } else {
    // Element/selector capture: render the node at the origin without its own
    // margin offsetting it inside the foreignObject.
    clone.style.margin = "0"
  }
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml")

  const xml = new XMLSerializer().serializeToString(clone)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  const img = await loadSvgImage(svgUrl)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(o.width * o.pixelRatio))
  canvas.height = Math.max(1, Math.round(o.height * o.pixelRatio))
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2d canvas context unavailable")
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return o.format === "jpeg" ? canvas.toDataURL("image/jpeg", o.quality) : canvas.toDataURL("image/png")
}

async function cropDataUrl(
  dataUrl: string,
  x: number,
  y: number,
  w: number,
  h: number,
  format: "png" | "jpeg",
  quality: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
        const out = format === "jpeg"
          ? canvas.toDataURL("image/jpeg", quality)
          : canvas.toDataURL("image/png")
        resolve(out)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function resolveTarget(action: DomScreenshotAction): { node: HTMLElement | null; error?: string } {
  const mode = action.mode || "full"
  switch (mode) {
    case "full":
    case "region":
      return { node: document.documentElement }
    case "element": {
      if (action.ref === undefined && action.index === undefined) {
        return { node: null, error: "element mode requires ref or index" }
      }
      const el = resolveElement(action.index, action.ref)
      if (!el) {
        const label = String(action.ref ?? action.index ?? "unknown")
        return { node: null, error: `stale element [${label}] — run interceptor state to refresh` }
      }
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `target is not an HTMLElement (got ${el.constructor.name})` }
      }
      return { node: el }
    }
    case "selector": {
      if (!action.selector) {
        return { node: null, error: "selector mode requires selector string" }
      }
      const el = document.querySelector(action.selector)
      if (!el) return { node: null, error: `selector not found: ${action.selector}` }
      if (!(el instanceof HTMLElement)) {
        return { node: null, error: `selector matched non-HTMLElement (got ${el.constructor.name})` }
      }
      return { node: el }
    }
    default:
      return { node: null, error: `unknown screenshot mode: ${mode}` }
  }
}

export async function handleDomScreenshot(action: DomScreenshotAction): Promise<ActionResult> {
  const { node, error } = resolveTarget(action)
  if (!node) return { success: false, error: error || "no target resolved" }

  const format = action.format === "jpeg" ? "jpeg" : "png"
  const qualityPct = typeof action.quality === "number" ? Math.max(1, Math.min(100, action.quality)) : 92
  const basePixelRatio = typeof action.scale === "number" && action.scale > 0
    ? action.scale
    : (window.devicePixelRatio || 1)

  const mode = action.mode || "full"
  const isFull = mode === "full" || mode === "region"

  // Capture dimensions: full/region use the document scroll size; element and
  // selector use the resolved node's bounding rect.
  let width: number
  let height: number
  if (isFull) {
    width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)
    height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  } else {
    const rect = node.getBoundingClientRect()
    width = Math.max(1, Math.ceil(rect.width))
    height = Math.max(1, Math.ceil(rect.height))
  }

  // Clamp pixelRatio so the rasterized canvas long-edge fits a caller-supplied
  // budget. Without a budget, behavior is unchanged.
  let pixelRatio = basePixelRatio
  const target = typeof action.target_max_long_edge === "number" && action.target_max_long_edge > 0
    ? action.target_max_long_edge
    : undefined
  if (target !== undefined) {
    const longEdgeCss = Math.max(width, height)
    if (longEdgeCss > 0 && longEdgeCss * pixelRatio > target) {
      pixelRatio = Math.max(0.05, target / longEdgeCss)
    }
  }

  try {
    let dataUrl = await nativeRenderToDataUrl(node, {
      width, height, pixelRatio, format, quality: qualityPct / 100, isFull
    })
    let outWidth = Math.round(width * pixelRatio)
    let outHeight = Math.round(height * pixelRatio)

    // Region mode: crop here in the content script before sending the dataUrl
    // back, so the inter-frame / SW→daemon messages stay small.
    if (mode === "region" && action.region) {
      const region = action.region
      const cropped = await cropDataUrl(
        dataUrl,
        Math.round(region.x * pixelRatio),
        Math.round(region.y * pixelRatio),
        Math.round(region.width * pixelRatio),
        Math.round(region.height * pixelRatio),
        format,
        qualityPct / 100
      )
      if (cropped) {
        dataUrl = cropped
        outWidth = Math.round(region.width * pixelRatio)
        outHeight = Math.round(region.height * pixelRatio)
      }
    }

    return {
      success: true,
      data: { dataUrl, format, width: outWidth, height: outHeight, pixelRatio, mode }
    }
  } catch (err) {
    return { success: false, error: `dom render failed: ${(err as Error).message}` }
  }
}
