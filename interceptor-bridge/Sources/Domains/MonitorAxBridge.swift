import Foundation
import AppKit
import ApplicationServices

// MonitorAxBridge owns one AXObserver per PID and emits monitor
// events to a callback. Per Apple docs (apple-developer-docs/applicationservices/
// axnotificationconstants_h.md:7-13), an observer is per-application, registered
// against a pid_t, and you must add at least one observer per app you want to
// monitor. AXObserverGetRunLoopSource is added to CFRunLoopGetMain() so the
// callback fires on the main run loop alongside the rest of AppKit.
//
// Distinct from AccessibilityDomain.swift:617-653 — that observer subscribes
// to only four notifications and clears the global RefRegistry on every
// callback. Monitor's bridge subscribes to a richer set and
// has no ref-registry side effect; it only reads element attributes when the
// notification kind requires them.

final class MonitorAxBridge: @unchecked Sendable {
    typealias EventCallback = (_ event: String, _ data: [String: Any]) -> Void

    // The full notification set. Order matters only for dedup logging.
    static let defaultNotifications: [String] = [
        kAXFocusedUIElementChangedNotification as String,
        kAXFocusedWindowChangedNotification as String,
        kAXMainWindowChangedNotification as String,
        kAXValueChangedNotification as String,
        kAXSelectedTextChangedNotification as String,
        kAXTitleChangedNotification as String,
        kAXMenuOpenedNotification as String,
        kAXMenuClosedNotification as String,
        kAXMenuItemSelectedNotification as String,
        kAXSheetCreatedNotification as String,
        kAXLayoutChangedNotification as String,
        kAXSelectedRowsChangedNotification as String,
        kAXSelectedCellsChangedNotification as String,
        kAXApplicationActivatedNotification as String,
        kAXApplicationDeactivatedNotification as String,
        kAXWindowCreatedNotification as String,
        kAXWindowMovedNotification as String,
        kAXWindowResizedNotification as String,
        kAXWindowMiniaturizedNotification as String,
        kAXWindowDeminiaturizedNotification as String,
        kAXCreatedNotification as String,
        kAXUIElementDestroyedNotification as String
    ]

    private let lock = NSLock()
    private var observers: [pid_t: AXObserver] = [:]
    private var registered: [pid_t: [String]] = [:]
    private var callback: EventCallback?

    // coalesce the two highest-rate AX notifications
    // (kAXValueChanged → "input", kAXLayoutChanged → "layout_change"). These
    // fire continuously during scroll/typing; debouncing them per (pid,kind)
    // within `coalesceMs` collapses a storm into one event carrying the latest
    // value + a coalesced count, without dropping lower-rate notifications.
    // 0 = emit every notification (truly everything).
    private var coalesceMs = 0
    private var pendingCoalesced: [String: (event: String, data: [String: Any])] = [:]
    private var coalesceCounts: [String: Int] = [:]
    private var coalesceTimer: DispatchSourceTimer?
    private let coalesceQueue = DispatchQueue(label: "interceptor.monitor.ax.coalesce")

    func setCoalesceMs(_ ms: Int) {
        lock.lock(); defer { lock.unlock() }
        coalesceMs = max(0, ms)
    }

    // Holds context the C-style AXObserverCallback needs. The void * `refcon`
    // is an Unmanaged<MonitorAxBridge> opaque pointer; the per-PID context is
    // stored on the bridge instance and looked up by the element's pid.
    private static let cCallback: AXObserverCallback = { _, element, notification, refcon in
        guard let refcon = refcon else { return }
        let bridge = Unmanaged<MonitorAxBridge>.fromOpaque(refcon).takeUnretainedValue()
        bridge.dispatch(element: element, notification: notification as String)
    }

    func setCallback(_ cb: @escaping EventCallback) {
        lock.lock(); defer { lock.unlock() }
        self.callback = cb
    }

    /// Returns the list of notifications that successfully registered for `pid`.
    /// Empty array if observer creation fails (most often because the target
    /// app has no AX surface or the bridge isn't AX-trusted).
    @discardableResult
    func attach(pid: pid_t, notifications: [String] = MonitorAxBridge.defaultNotifications) -> [String] {
        lock.lock()
        if let existing = registered[pid] {
            lock.unlock()
            return existing
        }
        lock.unlock()

        var newObserver: AXObserver?
        let createStatus = AXObserverCreate(pid, MonitorAxBridge.cCallback, &newObserver)
        guard createStatus == .success, let observer = newObserver else {
            Platform.log("MonitorAxBridge: AXObserverCreate failed for pid \(pid) → \(createStatus.rawValue)")
            return []
        }

        let axApp = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var accepted: [String] = []
        for note in notifications {
            let st = AXObserverAddNotification(observer, axApp, note as CFString, refcon)
            if st == .success {
                accepted.append(note)
            }
        }

        // CFRunLoopAddSource targets the main run loop directly. Per the
        // existing AccessibilityDomain.swift:650 pattern this is called
        // synchronously from a main-thread caller (transport request or
        // NSWorkspace notification delivered on the main queue), so no
        // explicit DispatchQueue.main hop is needed and the AXObserver
        // doesn't have to cross an isolation boundary.
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )

        lock.lock()
        observers[pid] = observer
        registered[pid] = accepted
        lock.unlock()
        return accepted
    }

    func detach(pid: pid_t) {
        lock.lock()
        let observerOpt = observers.removeValue(forKey: pid)
        let registeredNotes = registered.removeValue(forKey: pid) ?? []
        lock.unlock()

        guard let observer = observerOpt else { return }
        let axApp = AXUIElementCreateApplication(pid)
        for note in registeredNotes {
            AXObserverRemoveNotification(observer, axApp, note as CFString)
        }
        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )
    }

    func detachAll() {
        flushCoalesced()
        lock.lock()
        let pids = Array(observers.keys)
        lock.unlock()
        for pid in pids { detach(pid: pid) }
    }

    func attachedPids() -> [pid_t] {
        lock.lock(); defer { lock.unlock() }
        return Array(observers.keys)
    }

    func registrationFor(pid: pid_t) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return registered[pid] ?? []
    }

    // MARK: - dispatch

    private func dispatch(element: AXUIElement, notification: String) {
        guard let cb = (lock.withLock { self.callback }) else { return }

        // Map the notification kind to our event name + supplemental fields.
        // For value/focus/title we read a small set of attributes off the
        // element to enrich the event. We deliberately avoid reading kAXValue
        // for kAXSecureTextField — the role is read first and the value is
        // masked.
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)

        var role: String?
        var subrole: String?
        var title: String?
        var name: String?

        readStringAttribute(element, kAXRoleAttribute, into: &role)
        readStringAttribute(element, kAXSubroleAttribute, into: &subrole)
        readStringAttribute(element, kAXTitleAttribute, into: &title)
        readStringAttribute(element, kAXDescriptionAttribute, into: &name)

        var data: [String: Any] = [:]
        data["pid"] = Int(pid)
        if let r = role { data["r"] = r }
        if let sr = subrole { data["sr"] = sr }
        if let t = title { data["n"] = t }
        else if let n = name { data["n"] = n }

        switch notification {
        case kAXValueChangedNotification as String:
            // Mask password fields — kAXSecureTextField subrole.
            let isSecure = (role == "AXSecureTextField") || (subrole == "AXSecureTextField")
            var value: String?
            if !isSecure { readStringAttribute(element, kAXValueAttribute, into: &value) }
            if let v = value {
                data["v"] = v.count > 256 ? String(v.prefix(256)) + "…" : v
            } else if isSecure {
                data["v"] = "***SECURE***"
            }
            emitMaybeCoalesced("input", data: data, pid: pid, cb: cb)

        case kAXFocusedUIElementChangedNotification as String:
            cb("focus", data)

        case kAXFocusedWindowChangedNotification as String,
             kAXMainWindowChangedNotification as String:
            cb("window_focus", data)

        case kAXSelectedTextChangedNotification as String:
            var sel: String?
            readStringAttribute(element, kAXSelectedTextAttribute, into: &sel)
            if let s = sel { data["sl"] = s.count }
            cb("selection", data)

        case kAXTitleChangedNotification as String:
            cb("title_change", data)

        case kAXMenuOpenedNotification as String:    cb("menu_open", data)
        case kAXMenuClosedNotification as String:    cb("menu_close", data)
        case kAXMenuItemSelectedNotification as String:
            cb("menu_select", data)

        case kAXSheetCreatedNotification as String:  cb("sheet", data)
        case kAXLayoutChangedNotification as String:
            emitMaybeCoalesced("layout_change", data: data, pid: pid, cb: cb)

        case kAXSelectedRowsChangedNotification as String,
             kAXSelectedCellsChangedNotification as String:
            cb("selection_rows", data)

        case kAXApplicationActivatedNotification as String:
            cb("ax_app_activated", data)
        case kAXApplicationDeactivatedNotification as String:
            cb("ax_app_deactivated", data)

        case kAXWindowCreatedNotification as String:
            mergeFrame(element, into: &data)
            cb("window_create", data)
        case kAXWindowMovedNotification as String:
            mergeFrame(element, into: &data)
            cb("window_move", data)
        case kAXWindowResizedNotification as String:
            mergeFrame(element, into: &data)
            cb("window_resize", data)
        case kAXWindowMiniaturizedNotification as String:
            cb("window_min", data)
        case kAXWindowDeminiaturizedNotification as String:
            cb("window_demin", data)

        case kAXCreatedNotification as String:
            cb("ax_create", data)
        case kAXUIElementDestroyedNotification as String:
            cb("ax_destroy", data)

        default:
            // Forward unknown notifications wrapped — keeps the bridge
            // forward-compatible if Apple adds new constants without code
            // changes here.
            data["notification"] = notification
            cb("ax_other", data)
        }
    }

    // debounce a high-rate notification per (pid,kind).
    private func emitMaybeCoalesced(_ event: String, data: [String: Any], pid: pid_t, cb: @escaping EventCallback) {
        let ms = lock.withLock { self.coalesceMs }
        if ms <= 0 { cb(event, data); return }
        let key = "\(pid):\(event)"
        lock.lock()
        pendingCoalesced[key] = (event, data)
        coalesceCounts[key] = (coalesceCounts[key] ?? 0) + 1
        let needTimer = coalesceTimer == nil
        if needTimer {
            let timer = DispatchSource.makeTimerSource(queue: coalesceQueue)
            timer.schedule(deadline: .now() + .milliseconds(ms))
            timer.setEventHandler { [weak self] in self?.flushCoalesced() }
            coalesceTimer = timer
            lock.unlock()
            timer.resume()
        } else {
            lock.unlock()
        }
    }

    private func flushCoalesced() {
        lock.lock()
        let cb = callback
        let pending = pendingCoalesced
        let counts = coalesceCounts
        pendingCoalesced.removeAll()
        coalesceCounts.removeAll()
        coalesceTimer?.cancel()
        coalesceTimer = nil
        lock.unlock()
        guard let cb = cb else { return }
        for (key, entry) in pending {
            var data = entry.data
            let n = counts[key] ?? 1
            if n > 1 { data["coalesced"] = n }
            cb(entry.event, data)
        }
    }

    private func readStringAttribute(_ element: AXUIElement, _ key: String, into target: inout String?) {
        var ref: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, key as CFString, &ref)
        if status == .success, let v = ref as? String {
            target = v
        }
    }

    private func mergeFrame(_ element: AXUIElement, into data: inout [String: Any]) {
        // kAXPositionAttribute is CGPoint, kAXSizeAttribute is CGSize.
        // Both are AXValueRefs and need AXValueGetValue to extract.
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef)
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
        var origin = CGPoint.zero
        var size = CGSize.zero
        if let p = posRef, CFGetTypeID(p) == AXValueGetTypeID() {
            AXValueGetValue(p as! AXValue, .cgPoint, &origin)
        }
        if let s = sizeRef, CFGetTypeID(s) == AXValueGetTypeID() {
            AXValueGetValue(s as! AXValue, .cgSize, &size)
        }
        data["frame"] = [
            "x": Int(origin.x),
            "y": Int(origin.y),
            "w": Int(size.width),
            "h": Int(size.height)
        ]
    }
}

// Tiny helper to make the `lock.withLock { ... }` pattern read better.
private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
