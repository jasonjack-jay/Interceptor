import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  assertMonitorTaskBlueprintReady,
  attachMonitorTaskSource,
  buildMonitorTaskTimeline,
  buildTeachableTranscriptSegments,
  createMonitorTask,
  detachMonitorTaskSource,
  generateMonitorTaskCaptureQuality,
  getMonitorTaskMetaPath,
  getMonitorTaskSourceManifestPath,
  getMonitorTaskSourceSnapshotDir,
  getMonitorTaskTranscriptSegmentsPath,
  monitorTaskExportObject,
  readMonitorTaskCaptureQuality,
  readMonitorTaskMeta,
  readMonitorTaskSourceManifest,
  readMonitorTaskTranscriptSegments,
  snapshotMonitorTaskSources,
  stopMonitorTask,
  repairMonitorTask,
  findLatestSessionSidForTask,
  synthesizeMonitorTaskTranscript,
  updateMonitorTaskMeta,
  validateSemanticTranscript,
  type SemanticTranscriptEntry,
} from "../shared/monitor-tasks"
import {
  appendSessionEvent,
  appendSessionNetArtifact,
  getSessionDir,
  readSessionMeta,
  writeSessionMeta,
} from "../shared/monitor-artifacts"

describe("monitor task envelope", () => {
  let taskRoot: string

  beforeEach(() => {
    taskRoot = mkdtempSync(join(tmpdir(), "interceptor-task-test-"))
    process.env.INTERCEPTOR_TASKS_DIR = taskRoot
    for (const sid of ["task-browser", "task-macos", "task-missing", "task-boundary", "task-stripe", "task-noisy", "task-legacy", "task-active-source", "task-codex-noise"]) {
      rmSync(getSessionDir(sid), { recursive: true, force: true })
    }
  })

  afterEach(() => {
    rmSync(taskRoot, { recursive: true, force: true })
    delete process.env.INTERCEPTOR_TASKS_DIR
  })

  function writeBrowserSession(sid = "task-browser") {
    writeSessionMeta({
      artifactVersion: 2,
      surface: "browser",
      sessionId: sid,
      startedAt: 1000,
      status: "stopped",
      paused: false,
      rootTabId: 10,
      instruction: "browser task",
      url: "https://example.com/",
      counts: { evt: 3, mut: 0, net: 0, nav: 0 },
      attachments: [],
    })
    appendSessionEvent(sid, { timestamp: new Date(1000).toISOString(), event: "mon_start", sid, taskId: "task-x", s: 0, t: 1000, tid: 10, url: "https://example.com/" })
    appendSessionEvent(sid, { timestamp: new Date(1100).toISOString(), event: "click", sid, taskId: "task-x", s: 1, t: 1100, r: "button", n: "Approve", tr: true })
  }

  function writeMacosSession(sid = "task-macos") {
    writeSessionMeta({
      artifactVersion: 1,
      surface: "macos",
      sessionId: sid,
      startedAt: 1050,
      status: "stopped",
      paused: false,
      rootPid: 123,
      rootBundleId: "com.tinyspeck.slackmacgap",
      rootApp: "Slack",
      instruction: "mac task",
      counts: { evt: 2, mut: 0, net: 0, nav: 0, ax: 1 },
      attachments: [],
      tcc: { accessibility: true },
      scope: { mode: "apps", apps: ["Slack"] },
      includes: [],
      excludes: [],
    })
    appendSessionEvent(sid, { timestamp: new Date(1050).toISOString(), event: "mon_start", sid, surface: "macos", s: 0, t: 1050, rootPid: 123, rootBundleId: "com.tinyspeck.slackmacgap", rootApp: "Slack" })
    appendSessionEvent(sid, { timestamp: new Date(1200).toISOString(), event: "window_focus", sid, surface: "macos", s: 1, t: 1200, app: "Slack", n: "HVM Ops" })
  }

  test("creates a durable task and attaches browser and macOS sessions", () => {
    writeBrowserSession()
    writeMacosSession()
    const task = createMonitorTask({ instruction: "teach 9 AM batch", mode: "human-teach" })
    const browser = attachMonitorTaskSource(task.taskId, "task-browser")
    const macos = attachMonitorTaskSource(task.taskId, "task-macos")
    const stopped = stopMonitorTask(task.taskId)

    expect(existsSync(getMonitorTaskMetaPath(task.taskId))).toBe(true)
    expect(browser.source.surface).toBe("browser")
    expect(macos.source.surface).toBe("macos")
    expect(stopped.status).toBe("stopped")
    expect(readMonitorTaskMeta(task.taskId)?.sourceSessions.length).toBe(2)
  })

  test("detaches a source session and reloads durable task metadata", () => {
    writeBrowserSession()
    const task = createMonitorTask({ instruction: "reload task", mode: "human-observe" })
    attachMonitorTaskSource(task.taskId, "task-browser")
    const detached = detachMonitorTaskSource(task.taskId, "task-browser", { reason: "scope complete" })
    const reloaded = readMonitorTaskMeta(task.taskId)

    expect(detached.source.status).toBe("detached")
    expect(detached.source.detachedAt).toBeNumber()
    expect(reloaded?.taskId).toBe(task.taskId)
    expect(reloaded?.sourceSessions[0]?.status).toBe("detached")
  })

  test("attaches a just-started browser session before artifacts flush", () => {
    const task = createMonitorTask({ instruction: "artifact race", mode: "human-observe" })
    const attached = attachMonitorTaskSource(task.taskId, "task-new-browser", {
      surface: "browser",
      rootTabId: 42,
    })

    expect(attached.source.surface).toBe("browser")
    expect(attached.source.rootTabId).toBe(42)
    expect(readMonitorTaskMeta(task.taskId)?.sourceSessions[0]?.sid).toBe("task-new-browser")
  })

  test("builds a deterministic timeline with source references", () => {
    writeBrowserSession()
    writeMacosSession()
    const task = createMonitorTask({ instruction: "merge sources", mode: "mixed" })
    attachMonitorTaskSource(task.taskId, "task-browser")
    attachMonitorTaskSource(task.taskId, "task-macos")

    const timeline = buildMonitorTaskTimeline(task.taskId)
    expect(timeline.length).toBeGreaterThanOrEqual(4)
    expect(timeline.map((entry) => entry.timestamp)).toEqual([...timeline.map((entry) => entry.timestamp)].sort((a, b) => a - b))
    expect(timeline.every((entry) => entry.sourceRef.sid)).toBe(true)
  })

  test("synthesizes transcript entries with source refs", () => {
    writeBrowserSession()
    const task = createMonitorTask({ instruction: "semantic transcript", mode: "human-teach" })
    attachMonitorTaskSource(task.taskId, "task-browser")

    const transcript = synthesizeMonitorTaskTranscript(task.taskId)
    expect(transcript.length).toBeGreaterThan(0)
    expect(transcript.every((entry) => entry.sourceRefs.length > 0)).toBe(true)
  })

  test("exports a coherent task record with two source sessions", () => {
    writeBrowserSession()
    writeMacosSession()
    const task = createMonitorTask({ instruction: "export task", mode: "mixed" })
    attachMonitorTaskSource(task.taskId, "task-browser")
    attachMonitorTaskSource(task.taskId, "task-macos")
    stopMonitorTask(task.taskId)
    buildMonitorTaskTimeline(task.taskId)
    synthesizeMonitorTaskTranscript(task.taskId)

    const exported = monitorTaskExportObject(task.taskId) as {
      task: { taskId: string; sourceSessions: Array<{ sid: string; surface: string; sourceArtifactRoot: string }> }
      timeline: unknown[]
      transcript: Array<{ sourceRefs: unknown[] }>
    }
    expect(exported.task.taskId).toBe(task.taskId)
    expect(exported.task.sourceSessions.map((source) => source.surface).sort()).toEqual(["browser", "macos"])
    expect(exported.task.sourceSessions.every((source) => source.sourceArtifactRoot)).toBe(true)
    expect(exported.timeline.length).toBeGreaterThan(0)
    expect(exported.transcript.every((entry) => entry.sourceRefs.length > 0)).toBe(true)
  })

  test("validator rejects transcript entries without source refs", () => {
    const invalid: SemanticTranscriptEntry = {
      version: 1,
      taskId: "task-bad",
      entryId: "tr-bad",
      timestampStart: 1,
      timestampEnd: 1,
      actor: "system",
      summary: "Invented line.",
      surfaces: ["browser"],
      sourceRefs: [],
      confidence: "low",
    }
    expect(() => validateSemanticTranscript([invalid])).toThrow("sourceRefs")
  })

  test("timeline export surfaces missing source diagnostics", () => {
    const task = createMonitorTask({ instruction: "missing source", mode: "human-observe" })
    updateMonitorTaskMeta(task.taskId, (current) => ({
      ...current,
      sourceSessions: [{
        sid: "task-missing",
        surface: "browser",
        attachedAt: Date.now(),
        modeAtAttach: current.mode,
        actorAtAttach: "human",
        sourceArtifactRoot: getSessionDir("task-missing"),
        status: "attached",
      }],
    }))

    const timeline = buildMonitorTaskTimeline(task.taskId)
    expect(timeline[0].sourceEventKind).toBe("source.missing")
    expect(timeline[0].orderConfidence).toBe("low")
  })

  test("snapshots source artifacts under the task root on stop", () => {
    writeBrowserSession()
    writeMacosSession()
    appendSessionNetArtifact("task-browser", {
      sid: "task-browser",
      kind: "fetch",
      url: "https://example.com/api",
      method: "GET",
      bodyPreview: "",
    })
    const task = createMonitorTask({ instruction: "snapshot sources", mode: "human-teach" })
    attachMonitorTaskSource(task.taskId, "task-browser")
    attachMonitorTaskSource(task.taskId, "task-macos")
    stopMonitorTask(task.taskId)

    expect(existsSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-browser"), "session.json"))).toBe(true)
    expect(existsSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-browser"), "events.jsonl"))).toBe(true)
    expect(existsSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-browser"), "net.jsonl"))).toBe(true)
    expect(existsSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-macos"), "session.json"))).toBe(true)
    expect(existsSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-macos"), "events.jsonl"))).toBe(true)
    expect(existsSync(getMonitorTaskSourceManifestPath(task.taskId))).toBe(true)
    const manifest = readMonitorTaskSourceManifest(task.taskId)
    expect(manifest.filter((entry) => entry.status === "present").length).toBeGreaterThanOrEqual(5)
    expect(readMonitorTaskMeta(task.taskId)?.sourceSessions.every((source) => source.sourceSnapshotRoot)).toBe(true)
  })

  test("finalizes copied source session metadata for task snapshots", () => {
    const sid = "task-active-source"
    const task = createMonitorTask({ instruction: "finalize snapshot metadata", mode: "human-teach" })
    const t0 = task.startedAt
    writeSessionMeta({
      artifactVersion: 2,
      surface: "browser",
      sessionId: sid,
      startedAt: t0,
      status: "active",
      paused: false,
      rootTabId: 10,
      url: "https://example.com/",
      counts: { evt: 1, mut: 0, net: 0, nav: 0 },
      attachments: [],
    })
    appendSessionEvent(sid, { event: "mon_start", sid, s: 0, t: t0, tid: 10, url: "https://example.com/" })
    appendSessionEvent(sid, { event: "click", sid, s: 1, t: t0 + 100, r: "button", n: "Continue", tr: true })
    attachMonitorTaskSource(task.taskId, sid)
    stopMonitorTask(task.taskId)

    const snapshotMeta = JSON.parse(readFileSync(join(getMonitorTaskSourceSnapshotDir(task.taskId, sid), "session.json"), "utf-8")) as {
      status: string
      endedAt?: number
      counts?: { evt?: number }
      taskSourceStatusAtSnapshot?: string
    }
    expect(snapshotMeta.status).toBe("stopped")
    expect(snapshotMeta.endedAt).toBeNumber()
    expect(snapshotMeta.counts?.evt).toBe(2)
    expect(snapshotMeta.taskSourceStatusAtSnapshot).toBe("active")
  })

  test("propagates task id and surface into browser and macOS source metadata", () => {
    writeBrowserSession()
    writeMacosSession()
    const task = createMonitorTask({ instruction: "metadata binding", mode: "mixed" })
    attachMonitorTaskSource(task.taskId, "task-browser")
    attachMonitorTaskSource(task.taskId, "task-macos")

    expect(readSessionMeta("task-browser")?.taskId).toBe(task.taskId)
    expect(readSessionMeta("task-browser")?.surface).toBe("browser")
    expect(readSessionMeta("task-macos")?.taskId).toBe(task.taskId)
    expect(readSessionMeta("task-macos")?.surface).toBe("macos")
  })

  test("writes task binding sidecar for legacy sources without original metadata", () => {
    const task = createMonitorTask({ instruction: "legacy binding", mode: "human-observe" })
    attachMonitorTaskSource(task.taskId, "task-legacy", { surface: "browser", rootTabId: 99 })
    stopMonitorTask(task.taskId)

    const bindingPath = join(getMonitorTaskSourceSnapshotDir(task.taskId, "task-legacy"), "task-binding.json")
    expect(existsSync(bindingPath)).toBe(true)
    const binding = JSON.parse(readFileSync(bindingPath, "utf-8")) as { taskId: string; surface: string }
    expect(binding.taskId).toBe(task.taskId)
    expect(binding.surface).toBe("browser")
  })

  test("classifies timeline entries into prelude active epilogue and out of bounds", () => {
    const sid = "task-boundary"
    writeSessionMeta({
      artifactVersion: 2,
      surface: "browser",
      sessionId: sid,
      startedAt: 0,
      status: "stopped",
      paused: false,
      rootTabId: 10,
      counts: { evt: 5, mut: 0, net: 0, nav: 0 },
      attachments: [],
    })
    appendSessionEvent(sid, { event: "mon_start", sid, s: 0, t: -10_000 })
    appendSessionEvent(sid, { event: "focus", sid, s: 1, t: 500 })
    appendSessionEvent(sid, { event: "click", sid, s: 2, t: 1_500, n: "Continue" })
    appendSessionEvent(sid, { event: "blur", sid, s: 3, t: 5_000 })
    appendSessionEvent(sid, { event: "mon_stop", sid, s: 4, t: 40_000 })
    const task = createMonitorTask({ instruction: "boundary", mode: "human-teach" })
    attachMonitorTaskSource(task.taskId, sid)
    updateMonitorTaskMeta(task.taskId, (current) => ({ ...current, startedAt: 1_000, endedAt: 2_000, status: "stopped" }))

    const timeline = buildMonitorTaskTimeline(task.taskId)
    expect(timeline.map((entry) => entry.boundary)).toContain("prelude")
    expect(timeline.map((entry) => entry.boundary)).toContain("active")
    expect(timeline.map((entry) => entry.boundary)).toContain("epilogue")
    expect(timeline.map((entry) => entry.boundary)).toContain("out_of_bounds")
    const segments = buildTeachableTranscriptSegments(task.taskId, timeline)
    expect(segments.every((segment) => segment.boundary !== "epilogue")).toBe(true)
    expect(segments.every((segment) => segment.sourceRefs.length > 0)).toBe(true)
  })

  test("labels sensitive browser handoffs and blocks blueprint readiness", () => {
    const sid = "task-stripe"
    const task = createMonitorTask({ instruction: "sensitive handoff", mode: "human-teach" })
    const t0 = task.startedAt
    writeSessionMeta({
      artifactVersion: 2,
      surface: "browser",
      sessionId: sid,
      startedAt: t0,
      status: "stopped",
      paused: false,
      rootTabId: 10,
      instruction: "billing handoff",
      url: "https://example.com/start",
      counts: { evt: 3, mut: 0, net: 0, nav: 1 },
      attachments: [],
    })
    appendSessionEvent(sid, { event: "mon_start", sid, s: 0, t: t0, tid: 10, url: "https://example.com/start" })
    appendSessionEvent(sid, { event: "nav", sid, s: 1, t: t0 + 100, u: "https://invoice.stripe.com/i/example" })
    appendSessionEvent(sid, { event: "click", sid, s: 2, t: t0 + 200, n: "Pay" })
    attachMonitorTaskSource(task.taskId, sid)
    stopMonitorTask(task.taskId)
    updateMonitorTaskMeta(task.taskId, (current) => ({ ...current, endedAt: t0 + 1_000 }))
    synthesizeMonitorTaskTranscript(task.taskId)

    const segments = readMonitorTaskTranscriptSegments(task.taskId)
    expect(segments.some((segment) => segment.requiresHumanReview && segment.privacyLabels.includes("sensitive_handoff"))).toBe(true)
    const quality = readMonitorTaskCaptureQuality(task.taskId)
    expect(quality?.counts.sensitiveHandoffs).toBeGreaterThan(0)
    expect(() => assertMonitorTaskBlueprintReady(task.taskId)).toThrow("not blueprint-ready")
    expect(assertMonitorTaskBlueprintReady(task.taskId, { forceDiagnostic: true }).taskId).toBe(task.taskId)
  })

  test("groups high-volume macOS scroll key and app context events into teachable segments", () => {
    const sid = "task-noisy"
    const task = createMonitorTask({ instruction: "group noisy macos", mode: "human-teach" })
    const t0 = task.startedAt
    writeSessionMeta({
      artifactVersion: 1,
      surface: "macos",
      sessionId: sid,
      startedAt: t0,
      status: "stopped",
      paused: false,
      rootPid: 123,
      rootBundleId: "com.tinyspeck.slackmacgap",
      rootApp: "Slack",
      counts: { evt: 8, mut: 0, net: 0, nav: 0, ax: 1 },
      attachments: [],
    })
    appendSessionEvent(sid, { event: "mon_start", sid, surface: "macos", s: 0, t: t0, rootApp: "Slack" })
    appendSessionEvent(sid, { event: "scroll", sid, surface: "macos", s: 1, t: t0 + 100 })
    appendSessionEvent(sid, { event: "scroll", sid, surface: "macos", s: 2, t: t0 + 200 })
    appendSessionEvent(sid, { event: "key", sid, surface: "macos", s: 3, t: t0 + 300, kc: "A" })
    appendSessionEvent(sid, { event: "key", sid, surface: "macos", s: 4, t: t0 + 400, kc: "B" })
    appendSessionEvent(sid, { event: "title_change", sid, surface: "macos", s: 5, t: t0 + 500, app: "Slack", n: "Ops" })
    appendSessionEvent(sid, { event: "title_change", sid, surface: "macos", s: 6, t: t0 + 600, app: "Slack", n: "Ops" })
    attachMonitorTaskSource(task.taskId, sid)
    stopMonitorTask(task.taskId)
    updateMonitorTaskMeta(task.taskId, (current) => ({ ...current, endedAt: t0 + 1_000 }))
    const transcript = synthesizeMonitorTaskTranscript(task.taskId)
    const segments = readMonitorTaskTranscriptSegments(task.taskId)

    expect(segments.length).toBeLessThan(transcript.length)
    expect(segments.some((segment) => segment.title.includes("Scrolled") && segment.sourceRefs.length > 1)).toBe(true)
    const quality = generateMonitorTaskCaptureQuality(task.taskId)
    expect(quality.counts.segmentRows).toBe(segments.length)
  })

  test("compresses noisy Codex prompt editing into human-scale teachable segments", () => {
    const sid = "task-codex-noise"
    const task = createMonitorTask({ instruction: "teach Codex prompting", mode: "human-teach" })
    const t0 = task.startedAt
    writeSessionMeta({
      artifactVersion: 1,
      surface: "macos",
      sessionId: sid,
      startedAt: t0,
      status: "stopped",
      paused: false,
      rootPid: 23411,
      rootBundleId: "com.openai.codex",
      rootApp: "Codex",
      counts: { evt: 80, mut: 0, net: 0, nav: 0, ax: 1 },
      attachments: [],
    })
    appendSessionEvent(sid, { event: "mon_start", sid, surface: "macos", s: 0, t: t0, rootApp: "Codex", rootBundleId: "com.openai.codex" })
    appendSessionEvent(sid, { event: "title_change", sid, surface: "macos", s: 1, t: t0 + 100, r: "AXPopUpButton", n: "cy-conversift" })
    appendSessionEvent(sid, { event: "click", sid, surface: "macos", s: 2, t: t0 + 200, r: "AXButton", n: "Prompt composer" })
    for (let i = 0; i < 40; i += 1) {
      appendSessionEvent(sid, { event: "selection", sid, surface: "macos", s: 3 + i * 3, t: t0 + 300 + i * 250 })
      appendSessionEvent(sid, { event: "mods", sid, surface: "macos", s: 4 + i * 3, t: t0 + 325 + i * 250 })
      appendSessionEvent(sid, {
        event: "input",
        sid,
        surface: "macos",
        s: 5 + i * 3,
        t: t0 + 350 + i * 250,
        r: "AXTextArea",
        v: `Goal: write a product planning document for the sample app using Interceptor as the testing harness. Draft ${i}.`,
      })
    }
    appendSessionEvent(sid, { event: "key", sid, surface: "macos", s: 200, t: t0 + 12_000, kc: "\r", tr: true })
    attachMonitorTaskSource(task.taskId, sid)
    stopMonitorTask(task.taskId)
    updateMonitorTaskMeta(task.taskId, (current) => ({ ...current, endedAt: t0 + 20_000 }))
    const transcript = synthesizeMonitorTaskTranscript(task.taskId)
    const segments = readMonitorTaskTranscriptSegments(task.taskId)
    const quality = generateMonitorTaskCaptureQuality(task.taskId)

    expect(transcript.length).toBeGreaterThan(80)
    expect(segments.length).toBeLessThanOrEqual(5)
    expect(segments.some((segment) => segment.title === "Drafted or edited Codex prompt")).toBe(true)
    expect(segments.some((segment) => segment.title === "Submitted Codex prompt")).toBe(true)
    expect(segments.every((segment) => !/^(browser|macos) event:/i.test(segment.title))).toBe(true)
    expect(quality.counts.rawTitleSegments).toBe(0)
    expect(quality.scores.transcriptCompression).toBe(1)
  })

  test("browser + macOS sessions attach to ONE envelope with SEPARATE source logs and a MERGED timeline", () => {
    const task = createMonitorTask({ instruction: "image generation teach", mode: "human-teach" })
    writeBrowserSession("task-browser")
    writeMacosSession("task-macos")
    attachMonitorTaskSource(task.taskId, "task-browser", { surface: "browser" })
    attachMonitorTaskSource(task.taskId, "task-macos", { surface: "macos" })

    const manifest = snapshotMonitorTaskSources(task.taskId)
    expect(manifest.length).toBeGreaterThan(0)

    // Separate source logs under per-sid snapshot dirs.
    const browserDir = getMonitorTaskSourceSnapshotDir(task.taskId, "task-browser")
    const macosDir = getMonitorTaskSourceSnapshotDir(task.taskId, "task-macos")
    expect(browserDir).not.toBe(macosDir)
    expect(existsSync(browserDir)).toBe(true)
    expect(existsSync(macosDir)).toBe(true)

    // One envelope, two sources.
    const meta = readMonitorTaskMeta(task.taskId)!
    expect(meta.sourceSessions.length).toBe(2)

    // Unified timeline merges both surfaces.
    const timeline = buildMonitorTaskTimeline(task.taskId)
    expect(timeline.some((entry) => entry.surface === "browser")).toBe(true)
    expect(timeline.some((entry) => entry.surface === "macos")).toBe(true)
  })

  test("monitor repair recovers an unattached macOS session and finalizes the envelope", () => {
    const task = createMonitorTask({ instruction: "repair me", mode: "human-teach" })
    // A live macOS session that names the task in its meta but never registered
    // (the split-brain failure the PRD targets).
    writeSessionMeta({
      artifactVersion: 1,
      surface: "macos",
      sessionId: "task-macos",
      startedAt: 2000,
      status: "stopped",
      endedAt: 2500,
      paused: false,
      taskId: task.taskId,
      rootPid: 5,
      rootApp: "Notes",
      instruction: "repair me",
      counts: { evt: 2, mut: 0, net: 0, nav: 0, ax: 1 },
      attachments: [],
      tcc: { accessibility: true },
      scope: { mode: "all", apps: [] },
      includes: [],
      excludes: [],
    })
    appendSessionEvent("task-macos", { event: "mon_start", sid: "task-macos", surface: "macos", s: 0, t: 2000 })
    appendSessionEvent("task-macos", { event: "window_focus", sid: "task-macos", surface: "macos", s: 1, t: 2100, app: "Notes", n: "Note" })

    // Before repair: empty, but recoverable by sid scan.
    expect(readMonitorTaskMeta(task.taskId)!.sourceSessions.length).toBe(0)
    expect(findLatestSessionSidForTask(task.taskId)).toBe("task-macos")

    const { report, attached } = repairMonitorTask(task.taskId, { snapshotSources: true })
    expect(attached).toContain("task-macos")
    expect(report.counts.sourceCount).toBe(1)
    expect(report.status).not.toBe("not_usable")
  })
})
