// core/index.mjs — the cogyard data layer. Pure, importable, no CLI dispatch,
// no HTTP, no UI. Barrel re-export over the per-concern modules in this dir
// (extracted byte-identically from the original monolith and split into
// modules without behavior change).
//
// ============================================================================
// CONTRACT — consumers of these exports
// ----------------------------------------------------------------------------
//   * server/  (same repo) imports the read functions for the /api surface.
//   * cli/tasks.mjs + cli/env.mjs (same repo) build the command surface on top.
//   * `cli/tasks.mjs find` is the authoritative id→file resolver (matches
//     id/filename-stem/slug, same as drift/claim/release).
//   * Do NOT remove, rename, or change the signature of any export without
//     updating server/ and cli/ in lockstep.
// ----------------------------------------------------------------------------
// Config locations: $COGYARD_HOME (default ~/.cogyard/) — projects.json +
// ports.json.
// ============================================================================

export { COGYARD_HOME, REGISTRY_PATH, WORKTREE_PORTS_PATH, PROJECTS_ROOT, resolveProjectsRoot } from './paths.mjs';
export { CONFIG_PATH, readConfig, writeConfig, projectDefaults, WEEK_STARTS, PORTAL_TABS, uiPrefs, readAddonConfig, writeAddonConfig } from './config.mjs';
export { SECRETS_PATH, loadSecrets, hasSecret, secretNames, secretsStatus, whereToSet, addSecretCommand, resetSecrets } from './secrets.mjs';
export { ICON_MIME, isIconPath, iconMime, iconVersion, listProjectImages, sanitizeProjectIcons, projectIconsError,
  sanitizeProjectIconBorders, projectIconBordersError } from './project-icons.mjs';
export { tryExec, execLoud, gitIdentityArgs, gitIdentityFlags, findRepoRoot, findTasksDir, gitP, defaultBranch, defaultBranchSync } from './exec.mjs';
export { statusLetter, parseNameStatusZ, parseNameStatusLine, parsePorcelainZ } from './git-file-status.mjs';
export { TASKS_DIR, IN_REPO_TASKS_DIR, TASKS_IGNORE, locateTasksDir, tasksDirOf, oldTasksDir, oldTasksDirProblem, ensureTasksLinkIgnored, excludeTasksLink } from './tasks-dir.mjs';
export { memoize, clearMemo } from './memo.mjs';
export { versionsFor } from './versions.mjs';
export { computePlan, planFor } from './plan.mjs';
export { addTouchesPaths, outsideList, branchChangedFiles, runningClashesFor, dryMerge, branchConflicts } from './touches.mjs';
export { recentlyDone } from './recently-done.mjs';
export { inProgressAll } from './in-progress.mjs';
export { PUBLISH_DEFAULTS, publishStatus, labelReleaseTags } from './publish.mjs';
export { STATUS, STATUSES, isValidStatus, isClosed, isOpen, satisfiesDeps, hasDoneDate, BUCKET_KEYS, bucketOf, waitingWhyOf } from './status.mjs';
export { validateTask, validateTasks, introducedErrors, normalizeTaskId, decisionLogProblems, decisionMarks, logCitesTask, NOT_FOR_LOG_MARK } from './validate.mjs';
export { closeability, closeableTasks, doneWithLeftovers, markerProblemsByFile, proseSettled, markerText, boxReport, mergeState, claimState, whoAmI, rewriteStatusLine } from './close.mjs';
export { liveParkNotes, describePark, parkRecordKey, cleanParkReason, writeParkNote, endParkNotes } from './park.mjs';
export { resolveAxes, axisLookup, registeredLabels, seedSharedAxes, DEFAULT_SHARED_AXES,
  readSharedAxes, readProjectAxes, sanitizeAxes, writeSharedAxes, writeProjectAxes } from './axes.mjs';
export { resolveSwitches, switchDefaults, readProjectSwitches, switchProblems, validateSwitches, writeProjectSwitches,
  SWITCHES_FILE, SWITCH_NAMES, REBASE_VALUES, VERSION_VALUES } from './switches.mjs';
export { stripInlineComment, parseScalar, parseFrontmatter, readTaskFile, taskFromContent, listTaskFiles, loadTasks, computeDerived } from './frontmatter.mjs';
export { CLAIMS_PATH, localClaim, setLocalClaim, recordReservation, clearReservation } from './claims.mjs';
export { readRegistry, writeRegistry, makeProjectEntry, registerProject, unregisterProject, discoverProjects, findProject, formerSlugs, ledgerSlugResolver } from './registry.mjs';
export { loadProject, computeStaleMap, loadProjectAsync, tasksToData } from './project.mjs';
export { DEFAULT_DOC_GLOBS, DEFAULT_THRESHOLD, docDriftCandidates, taskDeclarations, hubPaths, areaFor, entryNamesDoc } from './doc-drift.mjs';
export { BRIEFS_ROOT, HEARTBEATS_ROOT, DRIFT_ROOT, outputSlugs, briefsDir, heartbeatsDir, driftPath } from './job-output.mjs';
export { listBriefFiles, parseBriefFile, leadParagraph, normalizeBrief, newestBrief, listBriefs, briefCount, briefSummary, normalizeHeartbeat, readHeartbeats } from './briefs.mjs';
export { readDrift, hasDrift } from './drift.mjs';
export { loadPortAllocations, gitWorktrees, computeWorktrees, worktreesForProject, projectWorktreePaths } from './worktrees.mjs';
export { DISPOSABLE_DIRS, dirSizeKb, findDisposable, diskEligible, projectReclaim, reclaimReport } from './reclaim.mjs';
export { cleanupReport, projectCleanup, chatArchiveReadiness, actionFor, openChats,
  removeWorktree, removeCmd, undoCmd, unlockCmd } from './cleanup.mjs';
export { gitCommits, commitsPerDay, mergesPerDay, parseGraphLog, aheadBehind, matchBranchTask, gitDag, listStashes, spliceWorktreeRows, spliceStashRows, gitDagWithStashesAndWorktrees } from './git-views.mjs';
export { lightWorktreeStats, taskCountsFromFrontmatter, projectOverview, worktreeNamesForProject, annotateWorktree } from './overview.mjs';
export { worktreeUnmergedCount, projectUnmerged } from './unmerged.mjs';
export { inferStatus } from './analyze.mjs';
export { KINDS, convertToSharedStore, joinSharedStore, ensureProjectWiring, prepareInitDir } from './scaffold.mjs';
export { AREAS as PROCESS_AREAS, OUTCOMES as PROCESS_OUTCOMES, auditProcess, describeAudit, auditReservedNames, describeReservedNames, reconcileProcess, ownSkillName } from './process-docs.mjs';
export { SCAFFOLDS_DIR, scaffoldFor, scaffoldKinds } from './scaffolds/index.mjs';
export { adapter, NOOP, listDriverNames, resolveActive, loadAdapter, driverCredential, currentSessionId, agentSession, currentOwnerTurns } from './drivers.mjs';
export { checkOwnerWords } from './owner-words.mjs';
export { logoFile, installedLogo, fetchDriverLogo } from './driver-logo.mjs';
export { ADDONS_DIR, providesEnabled, listAddonIds, loadManifest, loadAddons, listAddons, addonStatuses, runAddonAction, addonConfig, saveAddonConfig, supportedHere, disabledSet, resetAddons } from './addons/index.mjs';
export { normalizeSchedule, normalizeBounds, prevSlot, nextSlot, isDue, DEFAULT_BOUNDS } from './addons/schedule.mjs';
export { JOBS_PATH, readJobs, listScheduledJobs, dueJobs, runScheduledJob, isRunning, setScheduleOverride, effectiveSchedule } from './addons/jobs.mjs';
export { PRICING_VERSIONS, activeVersions, priceFor, syncPricing, pricingStatus } from './pricing.mjs';
export { PRICING_PATH, readPricingStore, storedVersions, storedEntry, appendPricingVersion } from './pricing-store.mjs';
export { appendClaimEvent, resolveProjectForPath, collectUsage, collectActivity, repriceLedger, refreshPricing, readUsageLedger, readActivityLedger, usageRollup, projectUsage, taskUsage, transcriptsRoot, findTranscriptsForSession } from './usage.mjs';
export { activityRollup, activityDay, activityPunchcard,
  sessionTaskIdsAll, sessionTaskIds, SESSION_TASK_DISPLAY_CAP } from './activity.mjs';
export { chatsForTask, transcriptForChat } from './task-chats.mjs';
export { OPEN_TARGETS_PATH, openTargets, findOpenTarget, writeOpenTargets, resolveOpenArgs, resolveOpenCommand, defaultBrowserBundleId } from './open-targets.mjs';
export { runDoctor, NODE_FLOOR_MAJOR } from './doctor.mjs';
// The storage report (`cogyard tasks doctor` + GET /api/storage) — a different
// question from doctor.mjs's install preflight above.
export { storeHealth, canonicalStore, storeLinkState, storeSharedWith } from './store-health.mjs';
export { classifyStorePath, taskIdOfPath, auditCommit, commitFlags, pendingEntries, pendingFlags, storeFacts, storeGraph, storeFlagged, storeWindow } from './store-audit.mjs';
