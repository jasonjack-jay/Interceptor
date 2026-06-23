import { getTabGroupTitle, getTabGroupColor, getCandidateTitles } from "./brand-tab-group"

export let interceptorGroupId: number | null = null

function hasTabGroupApi(): boolean {
  return !!chrome.tabGroups && typeof chrome.tabGroups.query === "function"
}

export async function ensureInterceptorGroup(): Promise<number> {
  if (!hasTabGroupApi()) return -1
  if (interceptorGroupId !== null) {
    try {
      await chrome.tabGroups.get(interceptorGroupId)
      return interceptorGroupId
    } catch {
      interceptorGroupId = null
    }
  }
  // Re-discover by the CANDIDATE TITLE SET (resolved brand + previous + default "interceptor"),
  // not a single hardcoded title, so a group created under the default or a prior brand is re-adopted
  // rather than orphaned after a retitle + SW restart.
  const candidates = await getCandidateTitles()
  const groups = await chrome.tabGroups.query({})
  const match = groups.find((g) => typeof g.title === "string" && candidates.includes(g.title))
  if (match) {
    // Only rediscover if the group has at least one tab. An empty group label
    // persists briefly after the last tab closes; treating it as "exists" sets
    // interceptorGroupId non-null and causes the unmanaged-tab guard to fire
    // for every subsequent command on a real tab.
    const tabs = await chrome.tabs.query({ groupId: match.id })
    if (tabs.length > 0) {
      interceptorGroupId = match.id
      return interceptorGroupId
    }
  }
  return -1
}

export async function addTabToInterceptorGroup(tabId: number): Promise<number> {
  let groupId = await ensureInterceptorGroup()
  if (groupId === -1 && (!hasTabGroupApi() || typeof chrome.tabs.group !== "function")) return -1
  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: tabId })
    await chrome.tabGroups.update(groupId, {
      title: getTabGroupTitle(),
      color: getTabGroupColor() as `${chrome.tabGroups.Color}`,
    })
    interceptorGroupId = groupId
  } else {
    await chrome.tabs.group({ tabIds: tabId, groupId })
  }
  return groupId
}

export async function isTabInInterceptorGroup(tabId: number): Promise<boolean> {
  if (!hasTabGroupApi()) return true
  const tab = await chrome.tabs.get(tabId)
  if (interceptorGroupId === null) await ensureInterceptorGroup()
  return interceptorGroupId !== null && tab.groupId === interceptorGroupId
}

export const SENSITIVE_ACTIONS = new Set([
  "evaluate", "cookies_get", "cookies_set", "cookies_delete",
  "storage_read", "storage_write", "storage_delete"
])

export async function verifyTabUrl(tabId: number, expectedUrl?: string): Promise<string | null> {
  if (!expectedUrl) return null
  const tab = await chrome.tabs.get(tabId)
  if (tab.url && tab.url !== expectedUrl) {
    return `tab URL changed since last state read — expected ${expectedUrl}, got ${tab.url}`
  }
  return null
}

export function registerTabGroupListeners(): void {
  if (!hasTabGroupApi()) return
  chrome.tabs.onRemoved.addListener(async (_removedTabId) => {
    if (interceptorGroupId === null) return
    try {
      const tabs = await chrome.tabs.query({ groupId: interceptorGroupId })
      if (tabs.length === 0) interceptorGroupId = null
    } catch {
      interceptorGroupId = null
    }
  })
}
