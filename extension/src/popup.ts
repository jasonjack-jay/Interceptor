const input = document.getElementById("contextId") as HTMLInputElement
const saveBtn = document.getElementById("save") as HTMLButtonElement
const resetBtn = document.getElementById("reset") as HTMLButtonElement
const statusEl = document.getElementById("status") as HTMLDivElement

function showStatus(msg: string, ms = 1800) {
  statusEl.textContent = msg
  setTimeout(() => { statusEl.textContent = "" }, ms)
}

chrome.storage.local.get("contextId").then((stored) => {
  const contextId = (stored as { contextId?: unknown }).contextId
  if (typeof contextId === "string") input.value = contextId
})

saveBtn.addEventListener("click", async () => {
  const value = input.value.trim()
  if (!value) { showStatus("Context ID cannot be empty."); return }
  await chrome.storage.local.set({ contextId: value })
  showStatus("Saved.")
})

resetBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("contextId")
  input.value = ""
  showStatus("Reset — new ID assigned on next connect.")
})

// --- runtime tab-group label/color (white-label) ---
// This field is INJECTED dynamically and gated on `chrome.tabGroups`. It is NOT static
// `popup.html` markup, because `popup.js` is not copied to `dist-mv2/` — a static field would render
// as an ungated dead control in the shared MV2 Electron-bridge popup. Injecting from here means the
// field simply does not exist where `popup.js` does not run (MV2) or where tab groups are unavailable.
const hasTabGroups = !!(chrome as typeof chrome & { tabGroups?: unknown }).tabGroups
if (hasTabGroups) {
  const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]

  const wrap = document.createElement("div")
  wrap.style.marginTop = "14px"

  const brandLabel = document.createElement("label")
  brandLabel.textContent = "Tab group label"
  brandLabel.htmlFor = "brandTitle"
  wrap.appendChild(brandLabel)

  const titleInput = document.createElement("input")
  titleInput.id = "brandTitle"
  titleInput.type = "text"
  titleInput.placeholder = "e.g. interceptor"
  titleInput.spellcheck = false
  wrap.appendChild(titleInput)

  const colorSelect = document.createElement("select")
  colorSelect.id = "brandColor"
  colorSelect.style.cssText =
    "width:100%;margin-top:6px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;"
  for (const c of COLORS) {
    const opt = document.createElement("option")
    opt.value = c
    opt.textContent = c
    colorSelect.appendChild(opt)
  }
  colorSelect.value = "cyan"
  wrap.appendChild(colorSelect)

  const brandRow = document.createElement("div")
  brandRow.className = "row"
  const brandSave = document.createElement("button")
  brandSave.id = "brandSave"
  brandSave.textContent = "Save label"
  brandSave.style.cssText = "background:#0071e3;color:#fff;"
  brandRow.appendChild(brandSave)
  wrap.appendChild(brandRow)

  statusEl.parentElement?.insertBefore(wrap, statusEl)

  void chrome.storage.local.get("brandTabGroup").then((stored) => {
    const b = (stored as { brandTabGroup?: { title?: unknown; color?: unknown } }).brandTabGroup
    if (b && typeof b.title === "string") titleInput.value = b.title
    if (b && typeof b.color === "string" && COLORS.includes(b.color)) colorSelect.value = b.color
  })

  brandSave.addEventListener("click", async () => {
    const title = titleInput.value.trim()
    if (!title) { showStatus("Tab group label cannot be empty."); return }
    await chrome.storage.local.set({ brandTabGroup: { title, color: colorSelect.value } })
    showStatus("Tab group label saved.")
  })
}
