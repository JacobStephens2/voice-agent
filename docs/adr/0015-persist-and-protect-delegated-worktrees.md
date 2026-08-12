# Persist and protect Delegated Worktrees

Each Delegation will receive its own non-production branch and persistent isolated worktree. The worktree remains available until its pull request is merged or closed so the Subagent can resume, respond to review, or preserve unfinished work. Automation may remove only a clean completed worktree; any uncommitted state is quarantined and reported instead of being deleted, reset, or stashed, preserving the prohibition on destroying uncommitted work.
