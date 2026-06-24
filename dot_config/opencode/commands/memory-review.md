---
agent: review
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the session memory audit above. Note any stale status fields,
    orphaned references, or inconsistencies found. Surface any context the user
    may have forgotten from previous sessions.
---

SESSION MEMORY AUDIT. Audit `.opencode/project-memory/` aggressively. Compare
session files against the actual project state. Find stale, outdated, and
orphaned content.

**What to check**:

1. Status staleness: any `**Status**: active` on files last modified >2 days
   ago? These should be marked `completed` or `archived`.
2. Completed staleness: any `completed` sessions older than 7 days still
   referenced by active sessions? Flag these.
3. Any session memory been resolved for over 14 days? Flag for potential
   removal.
4. Orphans: references to deleted sessions, deleted files, broken file paths.
5. Project state vs memory: do session files reference files that no longer
   exist? Do they describe architectures or agents that have changed?
6. Consistency: do multiple sessions claim the same work? Are deferred tasks
   already completed based on the actual project state?
7. Consolidation: suggest consolidating multiple separate sessions of related
   work into one memory file.

**Output**:

```
## [memory-review] Audit Report

### Issues Found
- `session_file.md:line` — [stale status / orphaned reference / inconsistency /
  outdated content] → suggested fix: [what to change or update]

### Clean
- [items verified with no issues]
```

$ARGUMENTS
