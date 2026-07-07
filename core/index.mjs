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
//   * generateIndexMd / loadTasks feed _tasks/INDEX.md, which the bd-pickup-task
//     skill and the /cogyard natural-language path READ directly. INDEX.md is
//     consumed tooling, not portal display — do not retire it.
//   * Do NOT remove, rename, or change the signature of any export without
//     updating server/ and cli/ in lockstep.
// ----------------------------------------------------------------------------
// Config locations: $COGYARD_HOME (default ~/.cogyard/) — projects.json +
// ports.json.
// ============================================================================

export { COGYARD_HOME, REGISTRY_PATH, WORKTREE_PORTS_PATH, PROJECTS_ROOT, resolveProjectsRoot } from './paths.mjs';
export { CONFIG_PATH, STORES, readConfig, writeConfig, projectDefaults, WEEK_STARTS, PORTAL_TABS, uiPrefs } from './config.mjs';
export { tryExec, execLoud, findRepoRoot, findTasksDir, gitP, defaultBranch, defaultBranchSync } from './exec.mjs';
export { memoize, clearMemo } from './memo.mjs';
export { STATUS, STATUSES, isValidStatus, isClosed, isOpen, satisfiesDeps, hasDoneDate } from './status.mjs';
export { validateTask, validateTasks } from './validate.mjs';
export { stripInlineComment, parseScalar, parseFrontmatter, readTaskFile, listTaskFiles, loadTasks, computeDerived } from './frontmatter.mjs';
export { readRegistry, writeRegistry, makeProjectEntry, registerProject, unregisterProject, discoverProjects, findProject } from './registry.mjs';
export { loadProject, computeStaleMap, loadProjectAsync, tasksToData, generateIndexMd } from './project.mjs';
export { loadPortAllocations, gitWorktrees, computeWorktrees, worktreesForProject, projectWorktreePaths } from './worktrees.mjs';
export { gitCommits, commitsPerDay, mergesPerDay, parseGraphLog, aheadBehind, branchDivergence, matchBranchTask, gitDag, listStashes, spliceWorktreeRows, spliceStashRows, gitDagWithWorktrees } from './git-views.mjs';
export { lightWorktreeStats, taskCountsFromFrontmatter, projectOverview, worktreeNamesForProject, annotateWorktree } from './overview.mjs';
export { worktreeUnmergedCount, projectUnmerged } from './unmerged.mjs';
export { inferStatus } from './analyze.mjs';
export { KINDS, convertToSharedStore, joinSharedStore, ensureProjectWiring, prepareInitDir } from './scaffold.mjs';
export { SCAFFOLDS_DIR, scaffoldFor, scaffoldKinds } from './scaffolds/index.mjs';
export { adapter, NOOP, listDriverNames, resolveActive, loadAdapter } from './drivers.mjs';
export { ADDONS_DIR, listAddonIds, loadManifest, loadAddons, listAddons, addonStatuses, runAddonAction, supportedHere, resetAddons } from './addons/index.mjs';
export { PRICING_VERSIONS, priceFor } from './pricing.mjs';
export { appendClaimEvent, resolveProjectForPath, collectUsage, collectActivity, readUsageLedger, readActivityLedger, usageRollup, projectUsage, taskUsage, transcriptsRoot, findTranscriptsForSession } from './usage.mjs';
export { activityRollup, activityDay, activityPunchcard } from './activity.mjs';
export { OPEN_TARGETS_PATH, openTargets, findOpenTarget, writeOpenTargets, resolveOpenArgs, resolveOpenCommand, defaultBrowserBundleId } from './open-targets.mjs';
export { runDoctor, NODE_FLOOR_MAJOR } from './doctor.mjs';
