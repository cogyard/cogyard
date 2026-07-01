#!/usr/bin/env bash
# UserPromptSubmit hook: when the user asks to WRITE / FILE / PARK / SPEC a new
# task in a cogyard-enabled project, force Claude through the write-task
# skill instead of letting it author the _tasks/NNN-*.md file by hand (or
# reserve an id via tasks.mjs first).
#
# WHY THIS EXISTS: skills are model-JUDGMENT triggers, not deterministic. The
# write-task description says "trigger when the user says 'write a task'",
# but the model can and does override that and start doing the work manually.
# This hook is the deterministic enforcement the skill system lacks.
#
# Stdout from a UserPromptSubmit hook (exit 0) is injected into Claude's context
# for THIS turn, before the model acts. We stay silent unless (a) we're in a
# cogyard project AND (b) the prompt reads as a write-a-new-task request.

payload="$(cat)"
prompt="$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)"
[ -z "$prompt" ] && prompt="$payload"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"
[ -z "$cwd" ] && cwd="$PWD"

# --- Gate 1: cogyard project only. ----------------------------------------
# A project is "part of cogyard" iff it has a `_tasks` entry (dir or symlink)
# at cwd or any ancestor up to (and including) $HOME.
is_cogyard_project() {
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -e "$dir/_tasks" ]; then return 0; fi
    [ "$dir" = "$HOME" ] && break
    dir="$(dirname "$dir")"
  done
  return 1
}
is_cogyard_project "$cwd" || exit 0

# --- Gate 2: exclude pickup-an-EXISTING-task intent (pickup-task owns it).
# "do task 37", "pick up task X", "work on task 12", "resume/continue task N".
if printf '%s' "$prompt" | grep -iqE '(do|pick ?up|work on|resume|continue|show me|open|finish) +(task|#) ?[0-9]+'; then
  exit 0
fi

# --- Gate 3: write/file/park/spec-a-NEW-task intent. -----------------------
# Filler words (a/an/the/new/another/quick/up) are repeatable + space-terminated
# so "write a new task", "write up a quick task", "write task" all match.
F='((a|an|the|new|another|quick|up|down|me) +)*'
WRITE_INTENT="(write|create|draft|author|make|jot|note|log|add) +${F}task"
WRITE_INTENT+='|file +(this|it|that|the +following)( +up)? +as +a +'"${F}"'task'
WRITE_INTENT+='|park +(this|it|that)\b'
WRITE_INTENT+='|spec +(this|it|that) +(it +)?out\b|spec +out\b'
WRITE_INTENT+='|save +(this|it|that) +as +a +(task|sub-?project|project)'
WRITE_INTENT+='|add +(this|it|that)?( +)?to +_?tasks\b'
WRITE_INTENT+='|new +task +file'

printf '%s' "$prompt" | grep -iqE "$WRITE_INTENT" || exit 0

cat <<'EOF'
=== TASK-WRITING REQUEST DETECTED — MANDATORY ROUTING ===

The user is asking you to write / file / park / spec a NEW task in a
cogyard-enabled project. This MUST be handled by the `write-task` skill.

BLOCKING GATE — before anything else for this request:
  • Do NOT start authoring the `_tasks/NNN-*.md` file by hand.
  • Do NOT reserve a task id (tasks.mjs / any id-allocation command) or run
    ANY other command first.
  • Your FIRST action this turn is: invoke the Skill tool with skill
    "write-task". The skill owns id reservation, frontmatter, and the
    shelf-stable body format. Doing it manually is the exact mistake this gate
    exists to prevent.

Only skip the skill if you have genuine reason to believe this is NOT a
new-task request (e.g. editing an existing task) — and say so explicitly
first. Otherwise: invoke write-task now.
EOF
exit 0
