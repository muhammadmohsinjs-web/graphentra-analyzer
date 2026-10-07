---
description: Commit and push the current work. If it belongs to a roadmap task, update that task in Obsidian
argument-hint: [task-id e.g. P0-1] [optional note]
---

Commit and push the current work. Arguments: `$ARGUMENTS`

## 1. Check before committing
- Run `git status` and `git diff`. If there is nothing to commit, say so and stop.
- Never stage `.env`, secrets, `node_modules`, `dist`, or `.graphentra/` output.
- Run `npm test`. If it fails, stop and report. Do not commit red code.

## 2. Commit and push
- Stage the changed files by name (no `git add -A`).
- Message style follows `git log`: `type(scope): summary`. If a task ID applies, put it in the summary or body (example: `fix(tests): repair stale evidence fixtures (P0-1)`).
- If the changes are unrelated, make separate commits.
- End the message with the Co-Authored-By line from the session's attribution reminder.
- Push the current branch (`git push`, or `git push -u origin <branch>` if it has no upstream). Never force-push. If the branch is `main`, stop and ask first.
- Get the short SHA with `git rev-parse --short HEAD`.

## 3. Update Obsidian (only if a roadmap task applies)
Task ID = the first token in the arguments that matches `P\d+-\d+` or `B-\d+`. If none is given, infer one only when the diff clearly matches a `###` task heading in the roadmap phase notes. If no task applies (a general fix, docs, refactor), skip this step. Never guess.

Vault: `/Users/muhammadmohsin/Documents/Obsidian/Graphentra Knowledge base/graphentra/03 Project Docs/Implementation Roadmap/` (standing permission to read and write; see memory `reference-graphentra-kb-vault`). Use plain text edits (no Dataview or Kanban).

1. **Hub tracker** (`Implementation Roadmap (Hub).md`): in the row that starts with `| <ID> |`, change only the status cell: `⬜` to `✅` if the task's "Done when" is met, or to `🔄` if the work is partial.
2. **Phase note** (`Phase N - ....md`): add or update one line directly after the task's callout block:
   `> [!success] Done YYYY-MM-DD · <short SHA> on <branch> · <one sentence on what changed and why>`
   Use `[!info] Progress` for partial work. Add one sentence for anything the note did not predict.
3. If this completes a checkbox in the phase's "exit gate" list, tick it.
4. Set `updated:` in that note's frontmatter to today's date.

Do not edit `ClickUp Tasks.md` or the `ClickUp Import/*.csv` files unless I ask.

## 4. Report
Reply in 4 lines or fewer: commit SHA and branch, push result, and which Obsidian notes changed (or "no task, Obsidian skipped"). If a step failed or was skipped, say which.
