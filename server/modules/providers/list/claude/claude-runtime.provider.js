/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT,
  resolveClaudeDefaultModelFlag
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getReportedClaudeContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();
// Held processes that are in the middle of a turn, keyed like activeSessions.
// Once a turn's `result` is out the chat run registry calls the session idle,
// and once its last task settles so does the background-work tracker — but the
// held CLI then runs one more turn of its own to relay that task's result (or
// a Monitor event, or a scheduled wake-up). Nothing else knows the session is
// busy during that turn, and closing stdin does not end it: a new turn that
// took the session over here would run next to it, both making tool calls and
// both appending to the same transcript.
const heldTurns = new Map();

// Longest delay a Node timer honours. A longer one overflows and fires after
// about 1 ms (with a TimeoutOverflowWarning), the opposite of what was asked.
const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Reads a millisecond setting from the environment.
 *
 * An explicit `0` is kept (for the approval timeout it means "wait
 * indefinitely"); `|| fallback` used to turn it back into the default. Values
 * above the longest timer delay are clamped to it instead of overflowing, and
 * a positive value below 1 ms becomes 1 ms rather than 0. Unset, empty, negative or non-numeric values use the fallback.
 *
 * Exported for `server/modules/providers/tests/claude-env-milliseconds.test.ts`,
 * which checks the parsing without reloading this module per environment value.
 * @param {string|undefined} raw - Raw environment value
 * @param {number} fallback - Value used when `raw` is not a usable number
 * @returns {number} Whole milliseconds in [0, MAX_TIMER_DELAY_MS]
 */
export function readMillisecondsEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[Claude SDK] Ignoring invalid millisecond setting "${raw}"; using ${fallback} ms`);
    return fallback;
  }
  if (value > MAX_TIMER_DELAY_MS) {
    console.warn(`[Claude SDK] ${raw} ms exceeds the longest timer delay; using ${MAX_TIMER_DELAY_MS} ms`);
    return MAX_TIMER_DELAY_MS;
  }
  // Only an explicit 0 means "no timeout": a positive fraction below 1 ms
  // rounds up instead of down to 0.
  return value > 0 ? Math.max(1, Math.floor(value)) : 0;
}

// 0 waits for the owner indefinitely, like interaction-required tools do.
const TOOL_APPROVAL_TIMEOUT_MS = readMillisecondsEnv(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 55000);

const DEFAULT_BG_WAIT_CEILING_MS = 30 * 60 * 1000;
// Anything shorter is far more likely a unit slip than a real ceiling: a value
// meant as minutes (`240` for four hours) would otherwise end the hold, and the
// background work with it, a quarter of a second into the silence.
const MIN_BG_WAIT_CEILING_MS = 60 * 1000;
// The longest delay setTimeout honours; Node fires anything longer after 1 ms.
const MAX_BG_WAIT_CEILING_MS = 2 ** 31 - 1;

/**
 * Reads the background-work ceiling (BG_WAIT_CEILING_MS below) from the
 * CLOUDCLI_BG_WAIT_CEILING_MS value the server was started with.
 *
 * The value is a whole number of milliseconds; unset or blank means the
 * 30-minute default. Anything else that is not a whole number, or is under a
 * minute, falls back to the default with a warning rather than being honoured
 * or silently dropped. A value past the longest timer Node supports is capped
 * there, since the timer would otherwise fire at once.
 *
 * Exported for the providers module's tests, which pin the parsing directly;
 * the runtime reads the variable once, at load.
 *
 * @param {string|undefined} rawValue - The variable as found in process.env
 * @param {(message: string) => void} [warn] - Receives the warning for a value that is not used as given
 * @returns {number} Ceiling in milliseconds
 */
export function resolveBgWaitCeilingMs(rawValue, warn = console.warn) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    return DEFAULT_BG_WAIT_CEILING_MS;
  }

  const fallback = `Using the default of ${DEFAULT_BG_WAIT_CEILING_MS} ms (30 minutes).`;
  if (!/^\d+$/.test(value)) {
    warn(`[Claude SDK] Ignoring CLOUDCLI_BG_WAIT_CEILING_MS="${value}": expected a whole number of milliseconds, e.g. 14400000 for 4 hours. ${fallback}`);
    return DEFAULT_BG_WAIT_CEILING_MS;
  }

  const ceilingMs = Number(value);
  if (ceilingMs < MIN_BG_WAIT_CEILING_MS) {
    warn(`[Claude SDK] Ignoring CLOUDCLI_BG_WAIT_CEILING_MS=${value}: the value is in milliseconds and must be at least ${MIN_BG_WAIT_CEILING_MS} (1 minute), e.g. 14400000 for 4 hours. ${fallback}`);
    return DEFAULT_BG_WAIT_CEILING_MS;
  }
  if (ceilingMs > MAX_BG_WAIT_CEILING_MS) {
    warn(`[Claude SDK] CLOUDCLI_BG_WAIT_CEILING_MS=${value} is longer than Node.js timers allow; using ${MAX_BG_WAIT_CEILING_MS} ms (about 24.8 days).`);
    return MAX_BG_WAIT_CEILING_MS;
  }
  return ceilingMs;
}

// How long a new turn waits for a held process to finish the turn it is in
// before taking the session over (see waitForHeldTurn). A relaying turn is an
// ordinary model turn — one observed relay ran 48 s with 8 tool calls — so two
// minutes lets a normal one finish without leaving the user's message stuck
// behind a turn that has gone wrong. Read per call so it can be tuned (and
// shortened in tests) without a restart of the module.
const DEFAULT_HELD_TURN_WAIT_MS = 120_000;
// A configured wait is held to [1 s, the largest delay setTimeout honours].
// Below the floor the wait is no wait at all, and above the ceiling Node fires
// the timer after 1 ms, so either would interrupt a relay that was about to end.
const MIN_HELD_TURN_WAIT_MS = 1_000;
const MAX_HELD_TURN_WAIT_MS = 2_147_483_647;
// After the wait, how long the interrupted turn gets to wind down before its
// process is closed outright. Never longer than the wait itself.
const HELD_TURN_INTERRUPT_GRACE_MS = 10_000;
// After a close, how long to wait for the old process to exit before the new
// run starts anyway. The SDK sends SIGTERM on close and SIGKILL 5 s later.
const HELD_PROCESS_EXIT_GRACE_MS = 6_000;

let reportedHeldTurnWaitMs = null;

/**
 * The configured held-turn wait: CLAUDE_HELD_TURN_WAIT_MS when it is a
 * positive number, clamped to [MIN_HELD_TURN_WAIT_MS, MAX_HELD_TURN_WAIT_MS],
 * otherwise the default.
 * @returns {number}
 */
function readHeldTurnWaitMs() {
  const raw = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  const configured = Number(raw);
  const waitMs = raw && Number.isFinite(configured) && configured > 0
    ? Math.min(Math.max(Math.floor(configured), MIN_HELD_TURN_WAIT_MS), MAX_HELD_TURN_WAIT_MS)
    : DEFAULT_HELD_TURN_WAIT_MS;
  if (raw && waitMs !== Number(raw) && reportedHeldTurnWaitMs !== waitMs) {
    reportedHeldTurnWaitMs = waitMs;
    console.warn(`[Claude SDK] CLAUDE_HELD_TURN_WAIT_MS=${JSON.stringify(raw)} is out of range or not a number; using ${waitMs} ms`);
  }
  return waitMs;
}

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them. Its
//     clock starts when stdin closes, so it comes on top of the hold below rather
//     than overlapping it.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
// Operators can change it with CLOUDCLI_BG_WAIT_CEILING_MS (see resolveBgWaitCeilingMs).
const BG_WAIT_CEILING_MS = resolveBgWaitCeilingMs(process.env.CLOUDCLI_BG_WAIT_CEILING_MS);

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Permission modes in which the CLI approves tools without calling
// `canUseTool`. Interaction-required tools reach the owner in these modes only
// through the PreToolUse hook registered in queryClaudeSDK.
const MODES_SKIPPING_CAN_USE_TOOL = new Set(['auto', 'bypassPermissions']);
// The composer modes an approved plan can hand the run to. `plan` itself and
// `dontAsk` are not offered by the composer, so they are never a way out.
const PLAN_RETURN_MODES = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions']);
// How long the CLI waits for the interaction hook, in seconds. The owner may
// take as long as they like over a plan or a question, but the CLI's default
// for a hook is ten minutes, after which it goes on without the answer. Kept
// well under the 24.8 days a Node timer can hold.
const INTERACTION_HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 * The mode a turn runs in. "Skip permissions" turns every mode but plan into
 * bypass, as the launch options do (mapCliOptionsToSDK), so a process that is
 * already running is moved to the same mode a new one would start in.
 * @param {string|undefined} mode - The mode the composer shows
 * @param {Object|undefined} toolsSettings - The message's tool settings
 * @returns {string|undefined}
 */
function effectivePermissionMode(mode, toolsSettings) {
  return toolsSettings?.skipPermissions && mode !== 'plan' ? 'bypassPermissions' : mode;
}

/**
 * The mode a message in plan mode asks to return to once its plan is approved
 * (the mode the composer showed before plan mode), or null when it names none.
 * @param {Object} options - Options of the message being sent
 * @returns {string|null}
 */
function planReturnModeOf(options) {
  return PLAN_RETURN_MODES.has(options.planReturnMode)
    ? effectivePermissionMode(options.planReturnMode, options.toolsSettings)
    : null;
}

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Without this the CLI forwards only a subagent's tool calls, so its card
  // shows the agent's prose and reasoning only after a reload reads them from
  // the transcript. The client folds these rows into the card by
  // parent_tool_use_id, the same way it folds the agent's tool calls.
  sdkOptions.forwardSubagentText = true;

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // `model` is the option the user picked and `modelFlag` what the CLI is started
  // with for it. They differ only for "Default", which can run the model set in
  // Claude Code's own settings or leave the flag off (see resolveClaudeDefaultModelFlag).
  if (options.modelFlag) {
    sdkOptions.model = options.modelFlag;
  }

  // Effort is validated against the option the user picked, whatever the flag is.
  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    options.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  // With these sources the CLI loads the user's MCP servers on its own (user
  // and local scope from ~/.claude.json, project scope from .mcp.json). Never
  // pass them as `sdkOptions.mcpServers`: the SDK serializes that into a
  // `--mcp-config <json>` argument, exposing every server's env and header
  // secrets to any local user through `ps` or /proc/<pid>/cmdline.
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {Function} [pushInput] - Pushes a steered message onto the held stdin stream
 * @param {Object} [held] - What a later message needs to continue this process instead of replacing it
 * @param {Function} held.continueTurn - Hands the run to a new writer and starts a turn's bookkeeping over; returns the turn's `ended` promise and an `undo`
 * @param {string|null|undefined} held.permissionMode - Permission mode the process runs in; null when it is not known
 * @param {string|undefined} held.modelFlag - Model the process runs
 * @param {() => boolean} held.isInputOpen - Whether the process still reads stdin
 * @param {(mode: string|undefined) => void} held.setPlanReturnMode - Records where an approved plan hands the run on
 * @param {boolean} held.hasInteractionHook - Whether AskUserQuestion/ExitPlanMode reach the owner through a PreToolUse hook, which any mode needs once the process is switched to one that skips `canUseTool`
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, pushInput = null, held = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    // Interrupt before releasing: the SDK drops control requests written after
    // stdin has ended (see releaseHeldSession), so an interrupt queued behind
    // the release never reaches the process.
    const reportInterruptError = (error) => {
      console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
    };
    try {
      Promise.resolve(existing.instance.interrupt()).catch(reportInterruptError);
    } catch (error) {
      reportInterruptError(error);
    }
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    // Same re-registration as releaseInput; lets steerClaudeSDKSession push a
    // message onto this run's held stdin stream.
    pushInput: pushInput || carried?.pushInput || null,
    // Same re-registration as pushInput: a later message continues this
    // process through it (see continueHeldSession).
    held: held || carried?.held || null,
    // Whether this run's turn has already sent its terminal `complete` (set
    // by the `result` handling in `queryClaudeSDK`). Carried like the other
    // fields above ONLY across a same-instance re-registration (the provider
    // session id landing mid-run re-registers writer/releaseInput/pushInput
    // on the same still-running turn, which is always before that turn's
    // `result`, so this is always false at that point in practice — carrying
    // it keeps this entry consistent with the others rather than for any
    // case where it would matter yet). A genuinely NEW run (superseding, so
    // `carried` is null) always starts false — it must be steerable from its
    // first turn, and the old run's completed-ness says nothing about it.
    turnCompleted: carried?.turnCompleted || false,
    // Steered messages not yet confirmed folded into the running turn,
    // keyed by uuid -> the prompt text that was pushed (cleared as each is
    // seen on an assistant `user_message_uuid`/`user_message_uuids`, on a
    // marker-based synthetic `user` echo that quotes the same text — see
    // `settlePendingSteerByMarker` — or on the next `result` if the CLI
    // never folds it). The text is kept (a Map, not a Set) so the
    // marker-based detector has something to match the echoed banner
    // against. A superseded run's pending steers die with its process, so
    // `carried` — already null for a superseding add — naturally resets
    // this to a fresh Map.
    pendingSteers: carried?.pendingSteers || new Map()
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Stops the background tasks a session's process still has going, then closes
 * its held stdin so the CLI can exit.
 *
 * Closing stdin is not enough on its own: the CLI's wind-down waits for the
 * background agents the process still has going — for up to the ceiling it
 * was started with (BG_WAIT_CEILING_MS) — so they would keep running, and
 * appending to the session's files, with nothing left that could stop them.
 * Stop the tasks first, while stdin is still open: the SDK drops control
 * requests written after stdin has ended.
 *
 * The stops are not awaited — each request is written to the CLI before this
 * returns, and a reply is only missing when the process has already gone.
 * @param {string} sessionId - Session identifier
 * @param {Object} session - The session's entry in the active sessions map
 */
function stopTasksAndReleaseInput(sessionId, session) {
  for (const task of backgroundWork.outstanding(sessionId)) {
    // A stop that cannot be delivered changes nothing about what happens
    // next: the process is on its way out either way. Guard the synchronous
    // call too, so a failing stop can never skip the release below.
    try {
      Promise.resolve(session.instance?.stopTask?.(task.taskId)).catch(() => {});
    } catch {
      // Same as a rejected stop.
    }
  }
  session.releaseInput?.();
}

/**
 * Lets go of the process an earlier run left holding a session open, so the
 * next turn can take the session over.
 *
 * Its tasks are stopped first: an abandoned process with an agent outstanding
 * would otherwise run next to the process that replaced it for as long as the
 * agent does, both appending to the same session file. The interrupt a later
 * supersede sends to this process cannot do the job, because it arrives after
 * stdin has ended.
 *
 * For the same reason the process is interrupted here, before anything else.
 * waitForHeldTurn only knows about a turn once the run loop has read its first
 * message, and a turn the CLI started on its own (a Monitor event, a scheduled
 * wake-up) may show nothing until the model's first token. An interrupt ends
 * such a turn; a process between turns has nothing to interrupt. Like the
 * stops, it is not awaited.
 * @param {string} sessionId - Session identifier
 * @param {{ interrupt?: boolean }} [options] - `interrupt: false` when the
 *   caller has already interrupted (or closed) this process
 */
function releaseHeldSession(sessionId, { interrupt = true } = {}) {
  const held = getSession(sessionId);
  if (!held) {
    return;
  }
  if (interrupt) {
    try {
      Promise.resolve(held.instance?.interrupt?.()).catch(() => {});
    } catch {
      // Same as a rejected stop: the process is on its way out.
    }
  }
  stopTasksAndReleaseInput(sessionId, held);
}

/**
 * True for a message from a held process that means it is running a turn of
 * its own: a task settling with a result the CLI will relay (a stopped task
 * gets no follow-up turn), or any main-thread conversation traffic. Task
 * progress and a background agent's own messages are not a turn.
 * @param {Object} message - SDK stream message
 * @returns {boolean}
 */
function startsHeldTurn(message) {
  if (message?.type === 'system') {
    return message.subtype === 'task_notification' && message.status !== 'stopped';
  }
  return ['assistant', 'user', 'stream_event'].includes(message?.type) && !message.parent_tool_use_id;
}

function beginHeldTurn(sessionKey, instance) {
  if (!sessionKey || heldTurns.has(sessionKey)) {
    return;
  }
  let end;
  const ended = new Promise((resolve) => { end = resolve; });
  heldTurns.set(sessionKey, { instance, ended, end, startedAt: Date.now() });
}

function endHeldTurn(sessionKey, instance) {
  const turn = heldTurns.get(sessionKey);
  if (!turn || turn.instance !== instance) {
    return;
  }
  heldTurns.delete(sessionKey);
  turn.end();
}

/**
 * Whether the process held open for a session's background work is running a
 * turn right now — typically the one relaying a task that just settled.
 * @param {string} sessionId - Session identifier
 * @returns {boolean}
 */
function hasActiveHeldTurn(sessionId) {
  return heldTurns.has(sessionId);
}

/**
 * Every session whose held process is running a turn of its own right now
 * (see hasActiveHeldTurn), with when that turn began. The running-sessions
 * poll lists these as a response in flight, which Stop can interrupt.
 * @returns {Array<{ sessionId: string, startedAt: number }>}
 */
function listActiveHeldTurns() {
  return [...heldTurns].map(([sessionId, turn]) => ({ sessionId, startedAt: turn.startedAt }));
}

function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Waits for a held process that is mid-turn to finish that turn, so a new run
 * never takes the session over while the old process is still making tool
 * calls. Bounded: past the wait the turn is interrupted while stdin is still
 * open — after release the SDK would drop the request — and a process that
 * still has not finished is closed outright, and given a few seconds to exit.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<'idle'|'finished'|'interrupted'|'closed'>} `idle` when no
 *   turn was running, `finished` when it ended by itself, `interrupted` when
 *   the wait ran out and the interrupt ended it (the process is still alive),
 *   `closed` when the process had to be closed
 */
async function waitForHeldTurnOutcome(sessionId) {
  const turn = heldTurns.get(sessionId);
  if (!turn) {
    return 'idle';
  }
  const waitMs = readHeldTurnWaitMs();
  console.log(`[Claude SDK] Session ${sessionId}: held process is mid-turn; waiting up to ${waitMs} ms for it to finish`);
  if (await settlesWithin(turn.ended, waitMs)) {
    console.log(`[Claude SDK] Session ${sessionId}: held turn finished; taking the session over`);
    return 'finished';
  }

  console.warn(`[Claude SDK] Session ${sessionId}: held turn still running after ${waitMs} ms; interrupting it`);
  try {
    Promise.resolve(turn.instance.interrupt?.()).catch(() => {});
  } catch {
    // Closing the process below covers an interrupt that cannot be sent.
  }
  if (await settlesWithin(turn.ended, Math.min(HELD_TURN_INTERRUPT_GRACE_MS, waitMs))) {
    console.warn(`[Claude SDK] Session ${sessionId}: interrupted held turn finished; taking the session over`);
    return 'interrupted';
  }

  console.warn(`[Claude SDK] Session ${sessionId}: interrupted held turn did not finish; closing its process`);
  try {
    turn.instance.close?.();
  } catch (error) {
    console.error(`Error closing held process for session ${sessionId}:`, error?.message || error);
  }
  // The run loop ends the turn when the process's stream closes. A tool the
  // old CLI still had running may outlive a process that has not exited, so
  // the new run waits for the exit, bounded.
  if (!await settlesWithin(turn.ended, HELD_PROCESS_EXIT_GRACE_MS)) {
    console.warn(`[Claude SDK] Session ${sessionId}: closed held process has not exited after ${HELD_PROCESS_EXIT_GRACE_MS} ms; taking the session over anyway`);
  }
  endHeldTurn(sessionId, turn.instance);
  return 'closed';
}

/**
 * Waits for a held process that is mid-turn to finish that turn (see
 * waitForHeldTurnOutcome).
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} true when the held process was interrupted or
 *   closed here, so the release need not interrupt it again
 */
async function waitForHeldTurn(sessionId) {
  const outcome = await waitForHeldTurnOutcome(sessionId);
  return outcome === 'interrupted' || outcome === 'closed';
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // The process has exited, or was let go with its tasks stopped
  // (stopTasksAndReleaseInput): nothing still tracked will report again.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Reconciles the session's `pendingSteers` against a CLI-emitted message that
 * confirms folding. The real CLI (2.1.280) stamps exactly one
 * `user_message_uuid` per frame but can fold several steered messages at the
 * same tool boundary, listing every one of them in `user_message_uuids`
 * (array). Deleting only the singular field leaves any additional folded
 * uuid stuck pending, which later reads as an unconfirmed steer and holds
 * stdin open needlessly. Both fields are undeclared on the pinned SDK
 * typings (the real CLI emits them regardless), so both are read
 * defensively.
 * @param {Object|undefined} session - Session data (as returned by getSession)
 * @param {Object} message - CLI message (`assistant` or `result`) that may carry the uuid(s)
 */
function settlePendingSteers(session, message) {
  const pendingSteers = session?.pendingSteers;
  if (!pendingSteers) {
    return;
  }
  if (typeof message.user_message_uuid === 'string') {
    pendingSteers.delete(message.user_message_uuid);
  }
  if (Array.isArray(message.user_message_uuids)) {
    for (const uuid of message.user_message_uuids) {
      if (typeof uuid === 'string') {
        pendingSteers.delete(uuid);
      }
    }
  }
}

// The SDK pinned here (0.3.165) bundles an older CLI build that has NO
// mid-turn fold signal at all — no `user_message_uuid` stamp and no marker
// banner below. Steering still works without either: with no fold signal
// `settlePendingSteers`/`settlePendingSteerByMarker` never clear the entry,
// so the `result` handling below correctly treats it as "about to run as its
// own turn" and defers `complete` by exactly one extra `result`, per
// `steerClaudeSDKSession`'s doc comment. Getting an actual mid-turn fold (and
// the earlier `complete`) requires `CLAUDE_CLI_PATH` pointing at a current
// CLI (>=2.1.x) or a newer SDK.
const STEER_FOLD_MARKER = '<system-reminder>\nThe user sent a new message while you were working:';

/**
 * Reads the plain text out of a live SDK message's content, whichever shape
 * the SDK used to frame it (a bare string, or Anthropic-style content
 * blocks).
 * @param {Object} message - CLI message
 * @returns {string}
 */
function extractSdkMessageText(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('\n');
  }
  return '';
}

/**
 * Second fold-confirmation signal, for CLIs that report a fold by echoing the
 * folded message back to the model instead of (or in addition to) stamping
 * `user_message_uuid` on the assistant frame that absorbed it (see
 * `settlePendingSteers`). The CLI surfaces it as a synthetic `user` message
 * (no `parent_tool_use_id`) whose text opens with a system-reminder banner
 * and quotes the folded prompt. Matching the banner text alone is not
 * specific enough when more than one steer is pending, so this also requires
 * the banner to contain the pending steer's own prompt text — stored
 * alongside its uuid in `pendingSteers` at push time (see
 * `steerClaudeSDKSession`).
 * @param {Object|undefined} session - Session data (as returned by getSession)
 * @param {Object} message - CLI message that may be the synthetic fold echo
 */
function settlePendingSteerByMarker(session, message) {
  const pendingSteers = session?.pendingSteers;
  if (!pendingSteers || pendingSteers.size === 0) {
    return;
  }
  if (message.type !== 'user' || message.parent_tool_use_id) {
    return;
  }
  const text = extractSdkMessageText(message);
  if (!text.includes(STEER_FOLD_MARKER)) {
    return;
  }
  for (const [uuid, steerText] of pendingSteers) {
    if (steerText && text.includes(steerText)) {
      pendingSteers.delete(uuid);
    }
  }
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow) {
  if (Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage, mainModel) {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage, reportedContextWindow) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * The context a compaction left behind, as a token budget.
 *
 * No assistant message states it: the compact boundary carries `post_tokens`,
 * and the next request's usage only arrives with the next answer. Without
 * this the meter keeps the size from before the compaction.
 * @param {Object} message - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} The budget, or null for any other message
 */
function extractCompactionTokenBudget(message, reportedContextWindow) {
  if (message?.type !== 'system' || message.subtype !== 'compact_boundary') {
    return null;
  }
  const metadata = message.compact_metadata ?? message.compactMetadata ?? {};
  const postTokens = readNumber(metadata.post_tokens ?? metadata.postTokens);
  return postTokens > 0
    ? buildTokenBudget({ input_tokens: postTokens, output_tokens: 0 }, reportedContextWindow)
    : null;
}

/**
 * The two halves of a request's cache accounting, each in every casing the SDK
 * has used for it.
 */
const CACHE_USAGE_KEY_GROUPS = [
  ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens'],
];

/**
 * Whether a usage payload accounts for the whole cache.
 *
 * Anthropic usage reports both halves, as zero when unused, so presence is the
 * test and not the value — and both are required, since a half reported alone
 * still leaves the other defaulting to zero in the prompt total.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {boolean} True when both cache halves are reported
 */
function reportsCacheAccount(messageUsage) {
  // Judge the alias buildTokenBudget will read (the first non-null one), not any alias.
  return CACHE_USAGE_KEY_GROUPS.every((keys) => {
    const key = keys.find((k) => messageUsage[k] != null);
    return key !== undefined && Number.isFinite(Number(messageUsage[key]));
  });
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  // A reading is one request's whole prompt: the uncached input plus both cache
  // halves. A payload that does not report both is a partial account, and its
  // `input_tokens` is only the uncached remainder — single digits against a warm
  // cache — so publishing it replaces a real figure with a wrong one.
  if (!reportsCacheAccount(messageUsage)) {
    return null;
  }

  const budget = buildTokenBudget(messageUsage, reportedContextWindow);

  // There is no context window without a prompt: an account that is zero
  // throughout is one of the messages the CLI writes itself (model
  // `<synthetic>`: the interrupt notice, an API error, the usage-limit line),
  // not a measurement of this conversation.
  if (budget.inputTokens <= 0) {
    return null;
  }

  return budget;
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   outstanding: (sessionKey: string) => Array<import('@/shared/types.js').BackgroundTaskSummary>,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   * @type {Map<string, Set<string>>}
   */
  const ownToolUseIds = new Map();

  const remove = (sessionKey, taskId) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey) {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * Stdin staying open on purpose is also what makes steering a running turn
 * possible: `push` queues one more record onto the exact same iterable the
 * SDK is already reading, the SDK writes it straight to the CLI's stdin just
 * like the initial prompt, and the CLI folds it into the running turn at its
 * next tool boundary — its own "queued message" behaviour — or, if the turn
 * ends before it gets the chance, runs the pushed record as a turn of its own.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (record: Object) => boolean, isOpen: () => boolean }}
 *   Stream plus its closer, pusher and open check. `release` is idempotent. `push` returns
 *   false once the stream is closed instead of queuing onto a dead process.
 */
function createHeldPromptStream(messages) {
  const queue = [...messages];
  let closed = false;
  let wake = null;

  const stream = (async function* () {
    for (;;) {
      while (queue.length) {
        yield queue.shift();
      }
      if (closed) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  const release = () => {
    closed = true;
    wake?.();
  };

  const push = (record) => {
    if (closed) {
      return false;
    }
    queue.push(record);
    wake?.();
    return true;
  };

  const isOpen = () => !closed;

  return { stream, release, push, isOpen };
}

/**
 * Outcome of a turn's `result` message. The SDK reports a failed turn either
 * with an `error_*` subtype (error_max_turns, error_during_execution,
 * error_max_budget_usd, ...) or with `is_error` on a `success` subtype (an API
 * error the CLI gave up on). Either way the turn did not complete.
 *
 * Exported for the runtime tests.
 * @param {Object} message - SDK `result` message
 * @returns {{ failed: boolean, reason: string }} `reason` is human-readable
 *   for a failed turn and `'completed'` otherwise
 */
export function resultOutcome(message) {
  const subtype = typeof message?.subtype === 'string' ? message.subtype : 'success';
  const failed = message?.is_error === true || subtype !== 'success';
  if (!failed) {
    return { failed: false, reason: 'completed' };
  }
  const details = Array.isArray(message?.errors)
    ? message.errors.filter((item) => typeof item === 'string' && item)
    : [];
  const text = details.length > 0
    ? details.join('; ')
    : (typeof message?.result === 'string' ? message.result : '');
  const kind = subtype === 'success' ? 'error' : subtype;
  return { failed: true, reason: text ? `${kind}: ${text}` : kind };
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // Set when this turn showed the client assistant text or an error, so an
  // error `result` can tell whether its reason was already on screen.
  let explanationSentThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel = null;
  let lastSentTokenBudget = null;
  // Set while the activity label says the conversation is being compacted.
  let compactionAnnounced = false;

  // A message sent while background agents still run belongs to the process
  // holding them: it takes the message as a turn of its own and the agents
  // keep working. Anything it cannot take (an edit that rewinds the
  // conversation, a process that already exited) falls through to a new one.
  if (sessionKey() && !options.resumeAnchorId && !options.resumeFromScratch) {
    let continued = null;
    try {
      continued = await continueHeldSession(sessionKey(), command, options, ws, context);
    } catch (error) {
      // An error here comes from preparing the message (its attachments, its
      // model), which a new process would run into as well; going the ordinary
      // way would only stop the agents first. The run reports it instead.
      console.error(`[Claude SDK] Session ${sessionKey()}: could not continue the held process:`, error?.message || error);
      throw error;
    }
    if (continued?.aborted) {
      // Stop was pressed while the message waited; the abort has already
      // closed this run, and the message must not start a process of its own.
      return;
    }
    if (continued) {
      await continued.ended;
      return;
    }
  }

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation — but only once
  // that process is between turns: releasing it mid-turn does not stop the
  // turn, it only leaves two processes working the session at once.
  if (sessionKey()) {
    const interrupted = await waitForHeldTurn(sessionKey());
    releaseHeldSession(sessionKey(), { interrupt: !interrupted });
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Messages the held process was handed after its first turn (see
  // continueHeldSession) wait here for their turn to end.
  let turnWaiters = [];
  const settleTurnWaiters = () => {
    const waiting = turnWaiters;
    turnWaiters = [];
    for (const resolve of waiting) {
      resolve();
    }
  };

  // Starts this loop's per-turn bookkeeping over for a message pushed into the
  // held process, and sends everything that follows to that message's writer.
  // `undo` puts the previous turn's state back when the push did not happen.
  const continueTurn = (nextWriter) => {
    const previous = { ws, turnCompleteSent, explanationSentThisTurn, sawTaskEventThisTurn, backgroundWorkPending };
    ws = nextWriter;
    turnCompleteSent = false;
    explanationSentThisTurn = false;
    sawTaskEventThisTurn = false;
    backgroundWorkPending = false;
    // The idle countdown measures a quiet hold, not a turn: one waiting on the
    // owner (a question, a plan) can be quiet for longer than that, and
    // releasing stdin under it would lose the answer. Its `result` re-arms it.
    const hadIdleRelease = Boolean(idleReleaseTimer);
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    turnWaiters.push(resolveEnded);
    return {
      ended,
      undo: () => {
        turnWaiters = turnWaiters.filter((resolve) => resolve !== resolveEnded);
        ({ ws, turnCompleteSent, explanationSentThisTurn, sawTaskEventThisTurn, backgroundWorkPending } = previous);
        if (hadIdleRelease) {
          scheduleRelease();
        }
      },
    };
  };
  let heldInfo = null;

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const selectedModel = resolvedModel || options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: selectedModel,
      // "Default" runs whatever Claude Code would run here (issue #1096).
      modelFlag: selectedModel === CLAUDE_PREDEFINED_MODELS.DEFAULT
        ? await resolveClaudeDefaultModelFlag(options.cwd)
        : selectedModel,
      effortModels,
    });

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // A run started in plan mode has no way back on its own: once the plan is
    // approved the CLI returns to the mode it started in (`default`), while the
    // composer shows the mode the user had before planning. The composer says
    // which one it shows, and the approval carries it to the CLI as a session
    // permission update. Only a plan mode run has a return mode.
    let planReturnMode = options.permissionMode === 'plan' ? planReturnModeOf(options) : null;

    // One decision per tool use. In a plan mode run that will leave plan for a
    // mode that skips `canUseTool` the owner is asked from a PreToolUse hook
    // (the later modes never reach canUseTool), and in plan mode itself the CLI
    // still calls canUseTool for the same tool use after the hook allows it.
    const interactionDecisions = new Map();
    const decideInteraction = (toolName, input, toolUseId, signal) => {
      if (toolUseId && interactionDecisions.has(toolUseId)) {
        return interactionDecisions.get(toolUseId);
      }
      const decision = requestOwnerApproval(toolName, input, signal);
      if (toolUseId) {
        interactionDecisions.set(toolUseId, decision);
        // A hook the CLI gave up on got no answer, only a cancellation: when
        // the CLI then asks canUseTool for the same tool use, the owner is
        // asked again instead of being told no on their behalf.
        void decision.then(() => {
          if (signal?.aborted && interactionDecisions.get(toolUseId) === decision) {
            interactionDecisions.delete(toolUseId);
          }
        });
      }
      return decision;
    };

    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        // The mode the process is in now: a message sent while agents run can
        // move a held process to another one (see applySendSettings), and the
        // mode it was launched in then says nothing about what to allow. A
        // mode that is not known (null) asks.
        const currentMode = heldInfo ? heldInfo.permissionMode : sdkOptions.permissionMode;
        if (currentMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }

        return requestOwnerApproval(toolName, input, context?.signal);
      }

      const decision = await decideInteraction(toolName, input, context?.toolUseID, context?.signal);
      // A subagent's own plan mode is not the session's: only the main thread's
      // approved plan hands the run on.
      if (decision.behavior === 'allow' && toolName === 'ExitPlanMode' && !context?.agentID) {
        // Where the CLI is once the plan is approved: the mode asked for, or the
        // one it restores itself, which is not known here.
        if (heldInfo) {
          heldInfo.permissionMode = planReturnMode ?? null;
        }
        if (planReturnMode) {
          return {
            ...decision,
            updatedPermissions: [{ type: 'setMode', mode: planReturnMode, destination: 'session' }]
          };
        }
      }
      return decision;
    };

    // Asks the owner through the UI and waits for the answer. Interaction-
    // required tools wait indefinitely; everything else uses the approval
    // timeout.
    const requestOwnerApproval = async (toolName, input, signal) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);
      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Interaction-required tools (AskUserQuestion, ExitPlanMode) go to the
    // owner in every permission mode. In 'auto' and 'bypassPermissions' the CLI
    // approves tools at the permission-mode step and never calls `canUseTool`,
    // so the model would act on an answer it generated itself. PreToolUse hooks
    // run before that step, so those modes ask the owner through one. The
    // other modes keep `canUseTool` as the only approval path: the CLI still
    // calls it for these tools after a hook's 'allow', so a hook there would
    // ask the owner twice.
    if (MODES_SKIPPING_CAN_USE_TOOL.has(sdkOptions.permissionMode) || MODES_SKIPPING_CAN_USE_TOOL.has(planReturnMode)) {
      sdkOptions.hooks.PreToolUse = [{
        matcher: [...TOOLS_REQUIRING_INTERACTION].join('|'),
        timeout: INTERACTION_HOOK_TIMEOUT_SECONDS,
        hooks: [async (input, toolUseId, hookOptions) => {
          const toolName = input?.tool_name;
          if (!TOOLS_REQUIRING_INTERACTION.has(toolName)) {
            return {};
          }
          const result = await decideInteraction(toolName, input?.tool_input, toolUseId ?? input?.tool_use_id, hookOptions?.signal);
          return {
            hookSpecificOutput: result.behavior === 'allow'
              ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: result.updatedInput }
              : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.message }
          };
        }]
      }];
    }

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    let hookedQuery = null;
    try {
      hookedQuery = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
      // `query()` returns before the CLI has answered the initialize request
      // that registers the hooks, so a rejected registration only shows here.
      if (typeof hookedQuery.initializationResult === 'function') {
        await hookedQuery.initializationResult();
      }
      queryInstance = hookedQuery;
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      // Shut down the failed attempt's CLI process before starting another.
      hookedQuery?.close?.();
      delete sdkOptions.hooks;
      // Without the PreToolUse hook, a mode that skips `canUseTool` would let
      // the model answer interaction-required tools itself: disallow them.
      if (MODES_SKIPPING_CAN_USE_TOOL.has(sdkOptions.permissionMode)) {
        sdkOptions.disallowedTools = [
          ...new Set([...(sdkOptions.disallowedTools || []), ...TOOLS_REQUIRING_INTERACTION])
        ];
      }
      // Likewise a plan must not lead into a mode that answers questions for
      // the owner: it keeps the mode the run started in, which asks.
      if (MODES_SKIPPING_CAN_USE_TOOL.has(planReturnMode)) {
        planReturnMode = null;
      }
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // What a later message needs to continue this process instead of replacing
    // it. Built once the hook question is settled: the interaction hook is what
    // makes a switch to a mode that skips `canUseTool` safe.
    heldInfo = {
      continueTurn,
      // The mode the process runs in now; null when it is not known (a plan was
      // approved and the CLI went back to the mode it keeps itself).
      permissionMode: sdkOptions.permissionMode ?? 'default',
      hasInteractionHook: Boolean(sdkOptions.hooks?.PreToolUse),
      modelFlag: sdkOptions.model,
      isInputOpen: () => heldPrompt.isOpen(),
      // Where an approved plan takes the process: the way out a message into
      // plan mode names, else the mode a message last moved it to (a plan the
      // model enters on its own returns there). False when the mode cannot be
      // one: a mode that skips `canUseTool`, on a process without the hook.
      setPlanReturnMode: (mode) => {
        const accepted = PLAN_RETURN_MODES.has(mode)
          && (!MODES_SKIPPING_CAN_USE_TOOL.has(mode) || Boolean(sdkOptions.hooks?.PreToolUse));
        planReturnMode = accepted ? mode : null;
        return accepted;
      },
    };

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, heldPrompt.push, heldInfo);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, heldPrompt.push, heldInfo);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        if (msg.kind === 'error' || msg.kind === 'stream_delta' || (msg.kind === 'text' && msg.role === 'assistant')) {
          explanationSentThisTurn = true;
        }
        ws.send(msg);
      }

      // The activity indicator reads its label from `status` frames; without
      // one it says "Thinking…" through a compaction that can run for minutes.
      // Once it is over the label goes back to the default (an empty status
      // clears it), and a compaction that failed says why.
      if (message.type === 'system' && message.subtype === 'status') {
        if (message.status === 'compacting') {
          compactionAnnounced = true;
          ws.send(createNormalizedMessage({ kind: 'status', text: 'Compacting conversation…', canInterrupt: true, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        } else if (compactionAnnounced) {
          compactionAnnounced = false;
          ws.send(createNormalizedMessage({ kind: 'status', text: '', canInterrupt: true, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          if (message.compact_result === 'failed') {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: `Compacting the conversation failed${message.compact_error ? `: ${message.compact_error}` : '.'}`,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'claude',
            }));
          }
        }
      }

      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // Only a turn's `result` states the window of the model that served it.
      const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
      const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
      if (turnContextWindow) {
        reportedContextWindow = turnContextWindow;
        rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
        if (contextWindowChanged && sessionKey()) {
          // A history page cached before this turn ended carries the old total.
          sessionHistoryCache.invalidate(sessionKey());
        }
      }

      // A resumed CLI first works through the task notifications left in the
      // transcript, as a turn of their own that ends in a `result` stamped
      // `origin: { kind: 'task-notification' }`, and only then reads this
      // turn's prompt. Current CLIs (seen on 2.1.280) do this on the next
      // message after a held run: the new process reports the old one's
      // background shell as stopped ("didn't finish before the previous
      // session ended"). That result is not this turn's end. Taken as one, it
      // sent `complete` ahead of the reply and released stdin before the
      // prompt had started anything, so background work the turn went on to
      // launch was killed as soon as the turn ended. Once this turn has
      // completed, a result with that origin is background work reporting
      // back, which the `result` branch below owns.
      const drainsEarlierNotification = message.type === 'result'
        && !turnCompleteSent
        && message.origin?.kind === 'task-notification';

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      const compactionBudget = extractCompactionTokenBudget(message, reportedContextWindow);
      if (compactionBudget) {
        // The turn's `result` bills the summary request, which is not what the
        // session holds now: its own reading must not replace this one.
        assistantBudgetSent = true;
      }
      let tokenBudgetData = compactionBudget
        || extractTokenBudget(message, reportedContextWindow)
        || (assistantBudgetSent || drainsEarlierNotification
          ? null
          : extractCumulativeTokenBudget(message, reportedContextWindow));
      if (
        !tokenBudgetData
        && turnContextWindow
        && lastSentTokenBudget
        && lastSentTokenBudget.total !== turnContextWindow
      ) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...lastSentTokenBudget, total: turnContextWindow };
      }
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'system' && message.subtype === 'task_started') {
        sawTaskEventThisTurn = true;
      }

      // The CLI confirms it folded a steered message into the running turn
      // by echoing the pushed record's uuid on the assistant reply that
      // absorbed it — `user_message_uuid` for the single fold, and every
      // folded uuid (including that same one) in `user_message_uuids` when
      // more than one steer lands at the same tool boundary. Both are
      // undeclared on the pinned SDK's `SDKAssistantMessage` type (the real
      // CLI emits them regardless), so `settlePendingSteers` reads both
      // defensively.
      // A superseding run may already own this session key (see the same
      // guard on `turnCompleted` below) — settle steers only against the
      // entry this run still owns, never a newer run's entry.
      const ownedSteerSession = (() => {
        const candidate = getSession(sessionKey());
        return candidate && candidate.instance === queryInstance ? candidate : undefined;
      })();
      if (message.type === 'assistant') {
        settlePendingSteers(ownedSteerSession, message);
      }
      // Second fold-confirmation signal — see `settlePendingSteerByMarker`
      // and the CLI-version note above `STEER_FOLD_MARKER`.
      settlePendingSteerByMarker(ownedSteerSession, message);
      backgroundWork.apply(sessionKey(), message);
      // A held process that starts a turn of its own is busy again until that
      // turn's `result`. Marked in the same step that settles the task, so the
      // session never reads idle between the settle and the relay.
      if (heldForBackgroundWork && startsHeldTurn(message)) {
        beginHeldTurn(sessionKey(), queryInstance);
      }

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
      ) {
        heldForBackgroundWork = false;
        releasePromptStream();
      }

      if (message.type === 'result' && !drainsEarlierNotification) {
        endHeldTurn(sessionKey(), queryInstance);
        // A `result` can itself carry the fold-confirmation uuid(s) (not
        // just the `assistant` frame that preceded it), so settle against
        // this message first — same helper, same defensive reads — before
        // deciding whether any steer is still unconfirmed.
        // Same ownership guard as above: a superseding run may already own
        // this session key, and this (old) run must not settle or read that
        // run's pending steers.
        const rawSession = getSession(sessionKey());
        const session = rawSession && rawSession.instance === queryInstance ? rawSession : undefined;
        settlePendingSteers(session, message);

        // A steer pushed onto this turn that the CLI never confirmed folding
        // (no `user_message_uuid`/`user_message_uuids` echo seen above) means
        // the CLI is about to run it as a turn of its own instead — the "if
        // the turn ends first" case `steerClaudeSDKSession` documents. Clear
        // here so only this one `result` is deferred for it: the follow-up
        // `result` the CLI is guaranteed to push for that turn then
        // completes normally below. If the CLI ever drops a steered message
        // without folding or following up, the idle ceiling still releases
        // stdin and the post-loop `!turnCompleteSent` branch sends the
        // (late) terminal complete.
        const pendingSteers = session?.pendingSteers;
        const steersPending = Boolean(pendingSteers && pendingSteers.size > 0);
        if (steersPending) {
          pendingSteers.clear();
        }

        // The turn is done as far as the client is concerned.
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
        if (!turnCompleteSent && !abortPending && !steersPending) {
          turnCompleteSent = true;
          // The terminal status follows the result: an error result ends the
          // turn as failed instead of being reported as a success.
          const outcome = resultOutcome(message);
          if (outcome.failed && (message.subtype !== 'success' || !explanationSentThisTurn)) {
            // An `error_*` subtype comes with no assistant text explaining it,
            // so the chat would otherwise just stop. An `is_error` success
            // result usually streams its error text as an assistant message
            // first; repeat the reason only when the turn showed nothing.
            ws.send(createNormalizedMessage({ kind: 'error', content: `Claude ended the turn with ${outcome.reason}`, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: outcome.failed ? 1 : 0 }));
          if (outcome.failed) {
            notifyRunFailed({
              userId: ws?.userId || null,
              provider: 'claude',
              sessionId: sessionId || capturedSessionId || null,
              sessionName: sessionSummary,
              error: new Error(outcome.reason)
            });
          } else {
            notifyRunStopped({
              userId: ws?.userId || null,
              provider: 'claude',
              sessionId: sessionId || capturedSessionId || null,
              sessionName: sessionSummary,
              stopReason: 'completed'
            });
          }
          // Record on the live session entry that this turn is done, even
          // though the process may stay held open for background work below.
          // `steerClaudeSDKSession` checks this to refuse folding a message
          // into a process that only looks steerable (`status === 'active'`,
          // `pushInput` still set) — see the race note on its docstring.
          // Guarded the same way the end-of-run cleanup below guards
          // `removeSession`: a superseding run may already own this session
          // key, and this (old) run must not stamp that run's entry.
          if (session && session.instance === queryInstance) {
            session.turnCompleted = true;
          }
        } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn
          // — the last of it, when nothing else is still running.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        // Work started during this turn, or work from an earlier turn that
        // has not settled yet (a follow-up turn reports one task in while
        // another is still going), is still running. Hold the process open
        // so it can finish and report back in a follow-up turn; the ceiling
        // is only a backstop for work that never reports.
        //
        // The release when the last task settles is this same branch on the
        // follow-up turn the CLI pushes for it, not the settling event
        // itself: closing stdin at that moment would cut the turn that
        // relays the task's result.
        //
        // When the turn reported its tasks, the tracker is the whole truth: an
        // Agent call without `run_in_background` is scored as background by
        // `startsBackgroundWork`, but the CLI runs it in the foreground and
        // it has settled before this `result` — holding for it kept a process
        // alive for the full ceiling with nothing outstanding.
        const holdForTurn = steersPending
          || (sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding);
        backgroundWorkPending = false;
        sawTaskEventThisTurn = false;
        explanationSentThisTurn = false;
        if (holdForTurn) {
          heldForBackgroundWork = true;
          scheduleRelease();
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          releasePromptStream();
        }
        // A message pushed into this process is done once its turn reported
        // complete (a deferred complete, for an unconfirmed steer, is not yet).
        if (turnCompleteSent) {
          settleTurnWaiters();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
    // A process that exits mid-turn has finished that turn too.
    endHeldTurn(sessionKey(), queryInstance);
    // And any message still waiting on this process has nothing left to wait for.
    settleTurnWaiters();
  }
}

/**
 * Whether a message can be handed to the process a session's earlier turn left
 * held open for its background work, instead of starting a process of its own.
 * @param {Object|undefined} session - The session's entry in the active sessions map
 * @returns {boolean}
 */
function isHeldForContinuation(session) {
  return Boolean(
    session
    && session.status === 'active'
    && session.pushInput
    && session.held?.continueTurn
    && session.turnCompleted
    // Stdin ends when the hold is released, well before the process exits; a
    // message sent to it then would wait for the exit, or be lost.
    && session.held.isInputOpen?.() !== false
  );
}

// How long a control request (permission mode, model) may take before a message
// stops waiting for it. The SDK answers one almost at once; one that does not
// is on a process that is not listening.
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Sends a user message into the process that holds a session open for its
 * background agents, as a turn of its own.
 *
 * Starting a new process for the message instead interrupts the held one and
 * stops every task it still has going (releaseHeldSession): sending "status?"
 * to a session with reviewers running ended them. The CLI itself lets you type
 * while background agents run, so the message goes to the same process and the
 * agents keep working and report back to it.
 *
 * Resolves `null` when there is nothing to continue — no held process, its
 * stdin already closed, or a relay turn that had to be closed — and the caller
 * starts the turn the ordinary way. Resolves `{ aborted: true }` when Stop was
 * pressed while the message waited: the abort has already closed its run, and
 * the message must not start a process of its own. Otherwise resolves once the
 * pushed turn has been handed over, with a promise for its end.
 * @param {string} sessionId - App session id
 * @param {string} command - User prompt
 * @param {Object} options - Same option shape `queryClaudeSDK` accepts for a turn
 * @param {Object} nextWriter - Writer of the run this message belongs to
 * @param {Object} context - Runtime context (model resolution)
 * @returns {Promise<{ uuid: string, ended: Promise<void> } | { aborted: true } | null>}
 */
async function continueHeldSession(sessionId, command, options, nextWriter, context) {
  const session = getSession(sessionId);
  if (!isHeldForContinuation(session)) {
    return null;
  }

  const generation = session.abortGeneration ?? 0;
  // Checked after every await. Stop pressed meanwhile ends the message, even a
  // Stop whose interrupt failed and left the process up; otherwise a process
  // that is no longer the same live, accepting one sends it the ordinary way.
  const lost = () => ((session.abortGeneration ?? 0) !== generation ? { aborted: true } : null);
  const stillHere = () => getSession(sessionId) === session && isHeldForContinuation(session);

  const [record] = await buildPromptMessages(command, options.images, options.files, options.cwd);
  if (lost() || !stillHere()) {
    return lost();
  }

  // The model the message asks for, resolved as a new process would resolve it.
  const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
  const selectedModel = resolvedModel || options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;
  const modelFlag = selectedModel === CLAUDE_PREDEFINED_MODELS.DEFAULT
    ? await resolveClaudeDefaultModelFlag(options.cwd)
    : selectedModel;
  if (lost() || !stillHere()) {
    return lost();
  }

  await applySendSettings(session, sessionId, options, modelFlag, nextWriter);
  if (lost() || !stillHere()) {
    return lost();
  }

  // A process mid-turn would fold the message into that turn, and the turn's
  // own `result` would then end this one before it had run. Between turns the
  // CLI starts it as a turn of its own. Checked last — a turn can begin during
  // any of the awaits above — and again after each wait, since another may
  // follow. A relay that outlasts the wait is interrupted; its process is
  // still good for the message unless it had to be closed. Each pass waits on
  // a turn of its own (agents that finish one after another are relayed one
  // after another), so the loop ends when they stop coming; giving up instead
  // would hand the message to a new process, which stops the agents still at work.
  while (heldTurns.has(sessionId)) {
    if (await waitForHeldTurnOutcome(sessionId) === 'closed' || lost() || !stillHere()) {
      return lost();
    }
  }

  // No await from here to the push: nothing can change under it.
  const turn = session.held.continueTurn(nextWriter);
  session.turnCompleted = false;
  const uuid = crypto.randomUUID();
  if (!session.pushInput({ ...record, uuid, origin: { kind: 'human' } })) {
    // The process closed its stdin between the check and the push.
    turn.undo();
    session.turnCompleted = true;
    return null;
  }
  session.writer = nextWriter;
  return { uuid, ended: turn.ended };
}

/**
 * Brings a held process's permission mode and model in line with the message
 * being sent, as far as a process that is already running can be.
 *
 * Not carried over: per-message reasoning effort and tool allow/deny settings,
 * which the CLI only reads at launch. The next process the session starts has them.
 *
 * A mode that skips `canUseTool` is not applied to a process that was started
 * without the interaction hook: it would answer AskUserQuestion and
 * ExitPlanMode itself. The process keeps its mode, which asks, and the user is
 * told in the conversation, since the composer says otherwise. The same goes
 * for a switch the CLI refuses or does not answer.
 * @param {Object} session - The session's entry in the active sessions map
 * @param {string} sessionId - App session id
 * @param {Object} options - Options of the message being sent
 * @param {string|undefined} modelFlag - The model flag the message resolves to
 * @param {Object} writer - Writer of the run the message belongs to, for notices
 */
async function applySendSettings(session, sessionId, options, modelFlag, writer) {
  const instance = session.instance;
  const held = session.held;
  const tell = (content) => {
    writer.send(createNormalizedMessage({ kind: 'error', content, sessionId, provider: 'claude' }));
  };

  // The mode a new process would start in for this message, "Skip
  // permissions" included.
  const nextMode = effectivePermissionMode(options.permissionMode, options.toolsSettings);
  if (nextMode && (PLAN_RETURN_MODES.has(nextMode) || nextMode === 'plan')) {
    if (MODES_SKIPPING_CAN_USE_TOOL.has(nextMode) && !held.hasInteractionHook) {
      tell(`This session's agents are still running in a process that was started to ask before it acts, so it keeps asking for now instead of switching to ${nextMode} mode. Messages sent after the agents finish use ${nextMode} mode.`);
    } else if (typeof instance?.setPermissionMode === 'function') {
      // Always sent, not only when the mode looks different: the CLI can leave
      // the mode this process was launched in on its own (a plan the model
      // entered or the user approved).
      try {
        if (await settlesWithin(Promise.resolve(instance.setPermissionMode(nextMode)), CONTROL_REQUEST_TIMEOUT_MS)) {
          held.permissionMode = nextMode;
          // A plan this message starts returns where the composer says. Any
          // other mode is where a plan the model starts on its own returns,
          // so no approval brings back a mode the user has since left.
          const returnMode = nextMode === 'plan' ? planReturnModeOf(options) : nextMode;
          if (!held.setPlanReturnMode?.(returnMode) && returnMode) {
            tell(`This session's agents are still running in a process that was started to ask before it acts, so once the plan is approved it keeps asking instead of switching to ${returnMode} mode.`);
          }
        } else {
          tell(`The running session did not answer the switch to ${nextMode} mode, so it keeps the mode it has.`);
        }
      } catch (error) {
        console.warn(`[Claude SDK] Could not switch held session to ${nextMode} mode:`, error?.message || error);
        tell(`The running session refused the switch to ${nextMode} mode, so it keeps the mode it has.`);
      }
    }
  }

  // An undefined flag is the CLI's own default, which a process that runs
  // another model can be switched back to.
  if (modelFlag !== held.modelFlag && typeof instance?.setModel === 'function') {
    const modelName = modelFlag ?? 'the default model';
    try {
      if (await settlesWithin(Promise.resolve(instance.setModel(modelFlag)), CONTROL_REQUEST_TIMEOUT_MS)) {
        held.modelFlag = modelFlag;
      } else {
        tell(`The running session did not answer the switch to ${modelName}, so it keeps the model it has.`);
      }
    } catch (error) {
      console.warn('[Claude SDK] Could not switch held session model:', error?.message || error);
      tell(`The running session refused the switch to ${modelName}, so it keeps the model it has.`);
    }
  }
}

/**
 * Pushes a user message into a running turn's stdin so the CLI folds it in at
 * its next tool boundary — the CLI's own "queued message" behaviour, driven
 * here instead of by the CLI's own interactive prompt. If the turn ends
 * before the CLI gets to fold it, the CLI runs the pushed record as a turn of
 * its own instead (see the run loop's `result` handling); either way the
 * message reaches the conversation exactly once.
 *
 * @param {string} sessionId - App session id (steering rides an existing
 *   run's process, so there is no provider-native id to key on)
 * @param {string} command - User prompt to push
 * @param {Object} [options] - Same option shape `queryClaudeSDK` accepts for a turn
 * @param {Array} [options.images] - Image descriptors
 * @param {Array} [options.files] - Non-image attachment descriptors
 * @param {string} [options.cwd] - Project working directory attachment paths resolve against
 * @returns {Promise<{ uuid: string } | null>} The pushed record's uuid, or
 *   null when there is no live, steerable process for this session (no
 *   session, a session that already ended, a process winding down, or one
 *   whose turn has already reported complete and is only being held open for
 *   background work — including when that happens while this call's
 *   `buildPromptMessages` await is still resolving, or when a newer run has
 *   superseded this session in the meantime)
 */
async function steerClaudeSDKSession(sessionId, command, options = {}) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.pushInput || session.turnCompleted) {
    return null;
  }

  const [record] = await buildPromptMessages(command, options.images, options.files, options.cwd);

  // The turn can send its terminal `complete` and settle into its post-turn
  // background-work hold while the await above is still resolving (slower
  // with image/file attachments) — re-check against the live session rather
  // than trusting the snapshot captured above. A different `instance` means a
  // newer run has replaced this session entirely (this run was superseded);
  // `turnCompleted` means this same run's turn finished while we were
  // building the message. Either way there is no live turn left to fold this
  // message into. Returning null here is safe for the caller
  // (`handleChatSteer` in chat-websocket.service.ts): once the run registry
  // also agrees the run is no longer processing, it delivers the message as
  // an ordinary new run instead of dropping it.
  const liveSession = getSession(sessionId);
  if (
    !liveSession
    || liveSession.instance !== session.instance
    || liveSession.status !== 'active'
    || !liveSession.pushInput
    || liveSession.turnCompleted
  ) {
    return null;
  }

  const uuid = crypto.randomUUID();
  // Stamped so the history reader (claude-sessions.provider.ts) can tell a
  // real human steer apart from a `queued_command` transcript row the CLI
  // wrote for something else it folds the same way (a background agent's or
  // peer session's own message) — those must not render as a plain user
  // bubble. Round-trips through the persisted transcript the same way `uuid`
  // already does (it comes back as the row's `source_uuid`).
  const pushed = liveSession.pushInput({ ...record, uuid, origin: { kind: 'human' } });
  if (!pushed) {
    // The process closed its stdin between the status check above and here.
    return null;
  }

  // Keyed on the raw command text (not the file-tag-wrapped `record.message
  // .content`) — that's what `settlePendingSteerByMarker` needs to find
  // inside the CLI's echoed banner, and it's a substring of the wrapped
  // content in the common (no-attachment) case too.
  liveSession.pendingSteers.set(uuid, command);
  return { uuid };
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);
    // A message waiting to be handed to this process (continueHeldSession)
    // compares it before and after, to tell Stop from a process that went away.
    session.abortGeneration = (session.abortGeneration ?? 0) + 1;

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Stop the background tasks the run started and release the held stdin
    // stream; without this the CLI stays up for the rest of the post-turn hold,
    // and its background agents keep working, even though the user cancelled.
    stopTasksAndReleaseInput(sessionId, session);

    // Whatever steer was pending dies with the interrupted process — the
    // closed stdin means the CLI will never fold it or run it as its own turn.
    session.pendingSteers?.clear();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  steer: steerClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  hasActiveHeldTurn,
  listActiveHeldTurns,
  stopBackgroundTask: stopClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  steerClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  hasActiveHeldTurn,
  listActiveHeldTurns,
  readHeldTurnWaitMs,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
