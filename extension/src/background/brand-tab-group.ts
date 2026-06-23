/**
 * extension/src/background/brand-tab-group.ts — runtime-configurable Chrome tab-group identity
 * (the visible tab-strip group `title` + `color`).
 *
 * The label/color is resolved at RUNTIME from chrome.storage with precedence
 * `managed` > `local` > built-in default `{ title: "interceptor", color: "cyan" }`, mirroring the
 * existing `contextId` storage pattern (see transport.ts). No rebuild, no options page.
 *
 * This module is module-load SIDE-EFFECT-FREE. It is transitively bundled into the MV2
 * `background-electron.js` (background-electron.ts -> transport.ts -> message-dispatch.ts ->
 * tab-group.ts -> here), so it must NOT touch `chrome.*` at import time. ALL chrome.storage access and
 * listener registration happens inside `registerBrandTabGroup()` / the accessors, and
 * `registerBrandTabGroup()` is called ONLY from the MV3 background.ts entry.
 */

import { ensureInterceptorGroup } from "./tab-group"

// Closed Chrome tabGroups color enum (verified against the tabGroups API docs).
const VALID_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const
export type TabGroupColor = (typeof VALID_COLORS)[number]

export const DEFAULT_TAB_GROUP_TITLE = "interceptor"
export const DEFAULT_TAB_GROUP_COLOR: TabGroupColor = "cyan"

const STORAGE_KEY = "brandTabGroup"
// "previous" title persisted across an onChanged-woken / restarted service worker so the
// candidate-title-set re-discovery can find a group that still bears the old label.
const SESSION_PREV_TITLE_KEY = "brandTabGroupPrevTitle"

export type BrandTabGroup = { title: string; color: TabGroupColor }

// Module-level cache, pre-seeded to the default so the very first SYNC read is never
// wrong-by-undefined (this literal is the only module-load state; no `chrome.*` here).
let cachedTitle: string = DEFAULT_TAB_GROUP_TITLE
let cachedColor: TabGroupColor = DEFAULT_TAB_GROUP_COLOR

/** Validate a color against the closed Chrome enum; invalid -> default `cyan` (never throws). */
export function normalizeColor(color: unknown): TabGroupColor {
  return typeof color === "string" && (VALID_COLORS as readonly string[]).includes(color)
    ? (color as TabGroupColor)
    : DEFAULT_TAB_GROUP_COLOR
}

/** Normalize a raw stored value into a complete, valid BrandTabGroup. */
export function normalizeBrandTabGroup(raw: unknown): BrandTabGroup {
  const obj = raw && typeof raw === "object" ? (raw as { title?: unknown; color?: unknown }) : {}
  const title =
    typeof obj.title === "string" && obj.title.trim().length > 0 ? obj.title : DEFAULT_TAB_GROUP_TITLE
  return { title, color: normalizeColor(obj.color) }
}

/** Sync, cache-backed accessor for the resolved tab-group title. */
export function getTabGroupTitle(): string {
  return cachedTitle
}

/** Sync, cache-backed (and re-validated) accessor for the resolved tab-group color. */
export function getTabGroupColor(): TabGroupColor {
  return normalizeColor(cachedColor)
}

// --- storage helpers (ALL chrome.* access lives below, never at module load) ---

/**
 * Defensive read of a storage area. In some Chromium builds `chrome.storage.managed` is undefined or
 * its `.get()` rejects when no managed_schema/policy exists; any miss/throw returns undefined so the
 * resolver falls through `managed` -> `local` -> default and NEVER throws.
 */
async function readArea(area: "managed" | "local"): Promise<BrandTabGroup | undefined> {
  try {
    const storageArea = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea | undefined>)[area]
    if (!storageArea || typeof storageArea.get !== "function") return undefined
    const stored = (await storageArea.get(STORAGE_KEY)) as Record<string, unknown>
    const raw = stored?.[STORAGE_KEY]
    if (raw === undefined || raw === null) return undefined
    return normalizeBrandTabGroup(raw)
  } catch {
    return undefined
  }
}

/** Resolve the brand with precedence managed > local > default. Never throws. */
async function resolveBrand(): Promise<BrandTabGroup> {
  const managed = await readArea("managed")
  if (managed) return managed
  const local = await readArea("local")
  if (local) return local
  return { title: DEFAULT_TAB_GROUP_TITLE, color: DEFAULT_TAB_GROUP_COLOR }
}

function sessionArea(): chrome.storage.StorageArea | undefined {
  const storage = chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }
  return storage.session
}

async function getPreviousTitle(): Promise<string | undefined> {
  try {
    const area = sessionArea()
    if (!area) return undefined
    const stored = (await area.get(SESSION_PREV_TITLE_KEY)) as Record<string, unknown>
    const v = stored?.[SESSION_PREV_TITLE_KEY]
    return typeof v === "string" ? v : undefined
  } catch {
    return undefined
  }
}

async function setPreviousTitle(title: string): Promise<void> {
  try {
    const area = sessionArea()
    if (!area) return
    await area.set({ [SESSION_PREV_TITLE_KEY]: title })
  } catch {}
}

/**
 * The candidate title set used by the cross-restart re-discovery path:
 * { resolved (current cache), previous (from session), default "interceptor" }. Querying this set lets
 * the adopt path re-adopt a group created under the default or a prior brand, rather than orphaning it
 * after a retitle + service-worker restart.
 */
export async function getCandidateTitles(): Promise<string[]> {
  const titles = new Set<string>()
  titles.add(cachedTitle)
  const prev = await getPreviousTitle()
  if (prev) titles.add(prev)
  titles.add(DEFAULT_TAB_GROUP_TITLE)
  return [...titles]
}

async function seedCache(): Promise<void> {
  const resolved = await resolveBrand()
  cachedTitle = resolved.title
  cachedColor = resolved.color
  await setPreviousTitle(cachedTitle)
}

/**
 * SW-restart-safe live re-title. On a `brandTabGroup` change: re-resolve the cache, then
 * ADOPT-THEN-RETITLE — re-discover the existing group via the candidate title set (which now includes
 * the OLD title) and adopt it into `interceptorGroupId`, then update its title+color in lockstep. A naive
 * `if (interceptorGroupId !== null) update(...)` guard would skip the retitle on an onChanged-woken SW
 * and orphan the group.
 */
async function onBrandChanged(change: chrome.storage.StorageChange): Promise<void> {
  const oldVal = change.oldValue
  const prevTitle =
    oldVal && typeof oldVal === "object" && typeof (oldVal as { title?: unknown }).title === "string"
      ? (oldVal as { title: string }).title
      : cachedTitle

  const resolved = await resolveBrand()
  cachedTitle = resolved.title
  cachedColor = resolved.color

  // Make the OLD title discoverable BEFORE re-discovery runs, so ensureInterceptorGroup's candidate
  // set can still find a group that currently bears the old label.
  if (prevTitle) await setPreviousTitle(prevTitle)

  // Adopt-then-retitle. ensureInterceptorGroup re-discovers via the candidate set and returns -1 when
  // the tabGroups API is absent (MV2) or no group exists yet.
  const gid = await ensureInterceptorGroup()
  if (gid === -1) {
    // No group yet — nothing to retitle; the next created group uses the fresh cache. Reset the
    // session "previous" to the new title so it doesn't linger as a stale candidate.
    await setPreviousTitle(cachedTitle)
    return
  }
  try {
    await chrome.tabGroups.update(gid, {
      title: cachedTitle,
      color: getTabGroupColor() as `${chrome.tabGroups.Color}`,
    })
    // The group now bears the new title; record it as the steady-state "previous".
    await setPreviousTitle(cachedTitle)
  } catch {
    // color/title rejected — already validated, but never let a retitle break grouping.
  }
}

/**
 * Seed the cache on service-worker startup and register the live-update listener. Called ONLY from the
 * MV3 background.ts entry (never background-electron.ts). Without this call the cache never seeds from
 * storage and onChanged never fires.
 */
export function registerBrandTabGroup(): void {
  void seedCache()
  chrome.storage.onChanged.addListener((changes, area) => {
    // The existing `contextId` listener ignores `managed`; this one handles BOTH `local` and `managed`
    // so an enterprise policy (deferred) or a local write both drive a live re-title.
    if (area !== "local" && area !== "managed") return
    const change = changes[STORAGE_KEY]
    if (!change) return
    void onBrandChanged(change)
  })
}
