import { connectToHost, connectWsChannel, registerAlarmListener, registerSwKeepaliveListener, registerStorageContextListener } from "./background/transport"
import { registerCdpListeners } from "./background/cdp"
import { registerTabGroupListeners, ensureInterceptorGroup } from "./background/tab-group"
import { registerBrandTabGroup } from "./background/brand-tab-group"

// Register all event listeners
registerCdpListeners()
registerTabGroupListeners()
registerAlarmListener()
registerSwKeepaliveListener()
registerStorageContextListener()
registerBrandTabGroup()

// Startup connections
chrome.runtime.onInstalled.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureInterceptorGroup()
})
chrome.runtime.onStartup.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureInterceptorGroup()
})

connectToHost()
connectWsChannel()
