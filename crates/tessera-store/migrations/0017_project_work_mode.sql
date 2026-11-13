-- How a project's tasks work: in its own worktrees (the default) or on branches inside the project folder.
ALTER TABLE projects ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'worktrees';
