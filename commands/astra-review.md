---
description: Send Claude-written code to GPT-6-Astra (ChatGPT, via Codex CLI) for an independent cross-provider review, then fix what it finds.
argument-hint: "[--base <branch> | --commit <sha> | --files <paths> | --files-from-commit <sha>] [extra reviewer instructions]"
---

# Astra Review

Cross-provider second opinion. Claude writes the code; GPT-6-Astra (OpenAI, running through the locally installed Codex CLI with your ChatGPT login) reviews it with no shared context. Claude then fixes what Astra finds and re-runs until Astra passes or the round limit is hit.

## Purpose

- Catch problems that a same-model reviewer shares blind spots on.
- Keep Claude as the only writer: Astra runs in a read-only sandbox and returns a structured verdict, never a patch.
- Produce a machine-readable verdict (PASS/FAIL, severity-tagged findings) that can gate a commit or push.

## Prerequisites

- Codex CLI installed and logged in with ChatGPT: `codex login`
- `gpt-6-astra` available on the account (check with `codex` model picker; override with `ECC_ASTRA_MODEL`)
- Invoking this command is your consent to send the diff to OpenAI. Do not run it on code you are not allowed to share.

## Usage

```
/astra-review                          # uncommitted changes (default)
/astra-review --base main              # everything on this branch vs main
/astra-review --commit HEAD~1          # one commit
/astra-review --files src/a.ts src/b.ts
/astra-review --files-from-commit HEAD~1  # repair round after a --commit review
/astra-review Focus on the SQL layer   # free text becomes extra reviewer instructions
```

## Workflow

### Step 1: Resolve scope

Parse `$ARGUMENTS`. Flags (`--base`, `--commit`, `--files`, `--files-from-commit`) select the scope; any remaining text is passed as `--instructions`. With no flags, review uncommitted changes.

Preview what will leave the machine before sending it:

```bash
ASTRA=""
for candidate in "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/scripts/astra-review.js" \
                 "./.claude/scripts/astra-review.js" \
                 "$HOME/.claude/scripts/astra-review.js" \
                 "./scripts/astra-review.js"; do   # plugin, project-local, global, the ECC repo itself
  [ -f "$candidate" ] && ASTRA="$candidate" && break
done
[ -n "$ASTRA" ] || { echo "astra-review.js not found; install ECC commands-core"; exit 2; }
node "$ASTRA" --dry-run [scope flags] | head -40
```

If the output says "Nothing to review", stop and tell the user.

### Step 2: Run the review

```bash
node "$ASTRA" --consent-to-openai [scope flags] \
  --instructions "<extra text, if any>" \
  --output "$(mktemp -d)/astra-review.json"   # private dir, never a shared predictable path
```

The script prints a markdown report and exits 0 (PASS), 1 (FAIL), or 2 (error). On exit 2, report the error verbatim and stop. Typical causes: Codex not installed, not logged in, model not available on the account, timeout.

### Step 3: Verdict gate

- **PASS** with no MEDIUM findings: report and finish.
- **PASS** with MEDIUM/LOW findings: list them, fix the ones that are clearly correct, and finish.
- **FAIL** (any CRITICAL or HIGH): go to Step 4.

### Step 4: Fix cycle (max 3 rounds)

1. Show every CRITICAL and HIGH finding with file and line.
2. Verify each one against the code before changing anything. Astra can be wrong; if a finding is a false positive, say so and skip it with a one-line reason.
3. Fix the confirmed findings. Change only what was flagged, no drive-by refactors.
4. Run the project's tests.
5. Re-run Step 2. The reviewer has no memory of earlier rounds. Scope on later rounds:
   - default and `--base`: unchanged. Both diff the working tree, so the repairs are included.
   - `--commit <sha>`: switch to `--files-from-commit <sha>`, which reviews the current contents of the files that commit touched (deleted paths are skipped, merge and root commits work). Re-running `--commit` would resend the original, unfixed diff.

After 3 rounds with remaining CRITICAL/HIGH findings, stop and hand the list to the user. Do not push.

### Step 5: Report

```
ASTRA VERDICT: [PASS / FAIL (escalated)]
Model:      gpt-6-astra
Scope:      [uncommitted | base main | commit sha | N files]
Rounds:     [N]/3

Fixed:          [findings fixed, with file:line]
False positive: [findings skipped, with reason]
Remaining:      [unresolved CRITICAL/HIGH, if any]
```

## Notes

- The script is `scripts/astra-review.js` under the plugin root; the library lives in `scripts/lib/astra-review/`. Always run it from the reviewed project's directory so git sees that project.
- `--base <branch>` diffs from the merge-base of `<branch>` and HEAD to the working tree, plus untracked files. Committed and uncommitted work on the branch are both included.
- Diffs over 200 KB are truncated; the reviewer is told to read the listed files with its read-only tools instead.
- Web search is disabled for the reviewer, the user-level Codex config is not loaded, and every MCP server Codex reports via `codex mcp list` is disabled by name (an empty `mcp_servers` table would not clear them). Only PATH/HOME-style variables reach the Codex process. API keys in your environment are not forwarded.
- To gate a push on this review, run it before `git push` and refuse to push on exit code 1. Pair with `/santa-loop` when you want two independent reviewers.
- If Codex is missing, fall back to `/code-review` and say clearly that no cross-provider review happened.
