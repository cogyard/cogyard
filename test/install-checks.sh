# test/install-checks.sh — the checks run on an installed cogyard package, shared by
# the Docker tests that install one. NOT run on its own: each test mounts it into its
# container as /checks.sh and sources it, so the checks cannot drift between them.
#
#   test/clean-machine.sh   — installs the tarball `npm pack` just built
#   test/registry-smoke.sh  — installs the version npm is actually serving
#
# What it defines:
#   ok / bad / hr / jfield   — PASS/FAIL lines, a separator, one field of JSON on stdin
#   FAIL                     — 0 until any `bad`; the caller exits with it
#   daily_routine <project dir> <project slug> <serve port> <section label>
#   package_checks <npm spec> <install label> <serve port> <section label>
#   INSTALLED                — the cogyard version package_checks found installed

FAIL=0; ok(){ echo "PASS: $1"; }; bad(){ echo "FAIL: $1"; FAIL=1; }; hr(){ echo "----------------------------------------"; }
# Print one field of the JSON object on stdin: `cmd | jfield file`.
jfield(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)[process.argv[1]];console.log(v==null?'':v)}catch{}})" "$1"; }

# DAILY ROUTINE — what a new user does in their first hour, after `init` and with
# `cogyard serve` up: reserve an id, write the task, validate it, commit it to the
# store, claim it, release it, see it in the plan, the store audit and the portal's
# API, and ask each command used for --help. The steps follow docs/QUICKSTART.md.
#   daily_routine <project dir> <project slug> <serve port> <section label>
daily_routine(){
  local dir="$1" slug="$2" port="$3" tag="($4)"
  hr; echo "DAILY ROUTINE $tag"
  cd "$dir" || { bad "cd $dir $tag"; return; }

  local res file store rel
  res=$(cogyard tasks next-id home-page 2>/tmp/nid.err)
  file=$(echo "$res" | jfield file); store=$(echo "$res" | jfield canonical)
  if [ -n "$file" ] && [ -e "$file" ] && [ ! -s "$file" ]; then
    ok "next-id reserved $(basename "$file") $tag"
  else
    bad "next-id did not reserve an empty file $tag"; echo "$res"; cat /tmp/nid.err; return
  fi
  # The quick start edits the file through the project's link to its store.
  rel=".cogyard/tasks/$(basename "$file")"
  [ -e "$rel" ] && ok "task file visible through .cogyard/tasks $tag" || bad "task file not visible through .cogyard/tasks $tag"

  cat > "$rel" <<TASK
---
id: 1
slug: home-page
title: A home page that says hello
status: OPEN
type: feature
created: $(date +%F)
created_at_commit: null
last_reviewed_at_commit: null
last_touched_commit: null
depends_on: []
related: []
touches_paths:
  - index.html
---

# 001: A home page that says hello

## Scope

- [ ] Write index.html with a heading that says "Hello from cogyard".
- [ ] Run npm run dev and confirm the page loads.
TASK
  cogyard tasks validate >/tmp/val.log 2>&1 && ok "tasks validate accepts the task $tag" \
    || { bad "tasks validate rejected the task $tag"; cat /tmp/val.log; }

  cogyard tasks sync push "add 001 home page" -- "$rel" >/tmp/push.log 2>&1 \
    && [ -n "$(git -C "$store" log --oneline -1 -- "$(basename "$file")" 2>/dev/null)" ] \
    && ok "sync push committed the task to the store $tag" \
    || { bad "sync push left no store commit for the task $tag"; cat /tmp/push.log; }

  cogyard env claim "$rel" test-session >/tmp/claim.log 2>&1 && ok "env claim $tag" \
    || { bad "env claim $tag"; cat /tmp/claim.log; }
  [ "$(cogyard tasks current 2>/dev/null | jfield count)" = 1 ] && ok "tasks current lists the claimed task $tag" \
    || bad "tasks current does not list the claimed task $tag"
  cogyard env release "$rel" >/tmp/rel.log 2>&1 && ok "env release $tag" \
    || { bad "env release $tag"; cat /tmp/rel.log; }
  [ "$(cogyard tasks current 2>/dev/null | jfield count)" = 0 ] && ok "tasks current is empty after release $tag" \
    || bad "tasks current still lists the task after release $tag"

  cogyard tasks plan >/tmp/plan.log 2>&1 && grep -q "A home page that says hello" /tmp/plan.log \
    && ok "tasks plan shows the task $tag" || { bad "tasks plan does not show the task $tag"; cat /tmp/plan.log; }
  # The store audit always exits 0; healthy is the project's row ending in "ok"
  # and no schema errors.
  cogyard tasks doctor >/tmp/tdoc.log 2>&1
  grep -Eq "^$slug +.* ok$" /tmp/tdoc.log && grep -q " 0 schema error(s) total" /tmp/tdoc.log \
    && ok "tasks doctor reports the store healthy $tag" || { bad "tasks doctor reports a problem $tag"; cat /tmp/tdoc.log; }

  node -e "fetch('http://127.0.0.1:$port/api/tasks?p=$slug').then(r=>r.json()).then(j=>process.exit((j.tasks||[]).some(t=>t.id===1&&t.title==='A home page that says hello')?0:1)).catch(()=>process.exit(1))" \
    && ok "portal API lists the task $tag" || bad "portal API (/api/tasks?p=$slug) does not list the task $tag"

  # --help must answer, not run the command: a --help that reached next-id would
  # reserve another id, so the store's file count must not move either.
  local before after c
  before=$(ls "$store" | wc -l)
  for c in "tasks next-id" "tasks validate" "tasks sync push" "tasks current" "tasks plan" "tasks doctor" "env claim" "env release"; do
    # shellcheck disable=SC2086
    if cogyard $c --help >/tmp/help.log 2>&1 && ! grep -Eq '^ +at |Error:' /tmp/help.log; then
      ok "cogyard $c --help $tag"
    else
      bad "cogyard $c --help $tag"; tail -10 /tmp/help.log
    fi
  done
  after=$(ls "$store" | wc -l)
  [ "$before" = "$after" ] && ok "--help changed nothing in the store $tag" || bad "--help changed the store ($before → $after files) $tag"
}

# PACKAGE CHECKS — a user's `npm i -g` of the package, with no repo and no devDeps:
# install it, run it, `init` a project, `serve` the portal from the BUNDLED build
# without attempting one, then the daily routine against that portal. Run it from
# a fresh $HOME with no other cogyard on PATH.
#   package_checks <npm spec> <install label> <serve port> <section label>
# <npm spec> is anything `npm i -g` takes (a tarball path, cogyard@1.2.3); the
# install label names it in the first PASS/FAIL line.
package_checks(){
  local spec="$1" what="$2" port="$3" section="$4" pid up i
  npm i -g "$spec" >/tmp/gi.log 2>&1 && ok "npm i -g $what" || { bad "npm i -g $what"; tail -25 /tmp/gi.log; }
  INSTALLED=$(npm ls -g cogyard --depth=0 2>/dev/null | sed -n 's/.*cogyard@//p' | head -1)
  echo "  installed: cogyard@${INSTALLED:-none}"
  command -v cogyard >/dev/null && ok "cogyard on PATH (global install)" || bad "cogyard not on PATH (global install)"
  cogyard --help >/dev/null 2>&1 && ok "cogyard --help (global install)" || bad "cogyard --help (global install)"
  cd "$HOME" || { bad "cd $HOME"; return; }
  cogyard init demo-pkg --kind single >/tmp/init2.log 2>&1 && ok "cogyard init (global install)" || { bad "cogyard init (global install)"; tail -25 /tmp/init2.log; }
  cogyard serve --port "$port" >/tmp/serve-pkg.log 2>&1 &
  pid=$!
  up=0
  for i in $(seq 1 60); do
    node -e "fetch('http://127.0.0.1:$port/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { up=1; break; }
    sleep 1
  done
  if [ "$up" = 1 ]; then
    ok "serve answered /api/health (global install)"
    grep -qi "building the portal UI" /tmp/serve-pkg.log && bad "serve tried to BUILD — bundled dist not found" || ok "no build attempted (bundled dist found)"
    node -e "fetch('http://127.0.0.1:$port/').then(async r=>{const b=await r.text();const html=r.status===200&&/<app-root|<!doctype html/i.test(b);const e503=/SPA not built/i.test(b);console.log('  GET / ->',r.status,'| html?',html,'| 503?',e503);process.exit(html&&!e503?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})" \
      && ok "portal UI served from BUNDLED dist (published-install path)" || bad "portal UI did not load from bundled dist"
  else
    bad "serve (global install) never came up"; tail -25 /tmp/serve-pkg.log
  fi
  daily_routine "$HOME/demo-pkg" demo-pkg "$port" "$section"
  kill "$pid" 2>/dev/null || true
}
