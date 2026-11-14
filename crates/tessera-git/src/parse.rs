//! Pure parsers for NUL-delimited Git machine output.
/// An attached worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Worktree {
    /// Worktree path as reported by Git (lossy for invalid UTF-8).
    pub path: String,
    /// HEAD object ID, including zero IDs in unborn repositories.
    pub head: Option<String>,
    /// Full branch ref.
    pub branch: Option<String>,
    /// Bare repository entry.
    pub bare: bool,
    /// Detached HEAD entry.
    pub detached: bool,
    /// Lock reason, empty when no reason was supplied.
    pub locked: Option<String>,
    /// Prune reason, empty when absent.
    pub prunable: Option<String>,
}
/// Parse `git worktree list --porcelain -z`; unknown attributes are ignored.
pub fn parse_worktrees(input: &[u8]) -> Vec<Worktree> {
    let mut result = Vec::new();
    let mut item = Worktree::default();
    for record in input.split(|b| *b == 0) {
        let record = String::from_utf8_lossy(record);
        if record.is_empty() {
            if !item.path.is_empty() {
                result.push(std::mem::take(&mut item));
            }
            continue;
        }
        let (key, value) = record.split_once(' ').unwrap_or((&record, ""));
        match key {
            "worktree" => item.path = value.into(),
            "HEAD" => item.head = Some(value.into()),
            "branch" => item.branch = Some(value.into()),
            "bare" => item.bare = true,
            "detached" => item.detached = true,
            "locked" => item.locked = Some(value.into()),
            "prunable" => item.prunable = Some(value.into()),
            _ => {}
        }
    }
    if !item.path.is_empty() {
        result.push(item);
    }
    result
}
/// One changed path and its index and working-tree states.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileStatus {
    /// Current path, with spaces and control characters preserved.
    pub path: String,
    /// Original path for rename/copy records.
    pub original_path: Option<String>,
    /// Index status letter.
    pub index: char,
    /// Working-tree status letter.
    pub worktree: char,
    /// Index has a change.
    pub staged: bool,
    /// Working tree has a change.
    pub unstaged: bool,
    /// Path is untracked.
    pub untracked: bool,
    /// Path was renamed.
    pub renamed: bool,
    /// Path has unmerged stages.
    pub conflicted: bool,
}
/// Repository status including optional branch tracking metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// Current branch; absent for detached HEAD.
    pub branch: Option<String>,
    /// Configured upstream branch.
    pub upstream: Option<String>,
    /// Commits ahead of upstream.
    pub ahead: u64,
    /// Commits behind upstream.
    pub behind: u64,
    /// Changed and untracked files.
    pub files: Vec<FileStatus>,
}
/// Parse porcelain v2 status; malformed records and future headers are ignored.
pub fn parse_status(input: &[u8]) -> Status {
    let mut result = Status::default();
    let mut records = input.split(|b| *b == 0);
    while let Some(raw) = records.next() {
        let record = String::from_utf8_lossy(raw);
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                result.branch = Some(value.into());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            result.upstream = Some(value.into());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut n = value.split_whitespace();
            result.ahead = n
                .next()
                .and_then(|s| s.strip_prefix('+'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            result.behind = n
                .next()
                .and_then(|s| s.strip_prefix('-'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            result.files.push(FileStatus {
                path: path.into(),
                untracked: true,
                ..Default::default()
            });
            continue;
        }
        let count = match raw.first() {
            Some(b'1') => 9,
            Some(b'2') => 10,
            Some(b'u') => 11,
            _ => continue,
        };
        let fields: Vec<_> = record.splitn(count, ' ').collect();
        let original = if raw.first() == Some(&b'2') {
            records.next().map(|r| String::from_utf8_lossy(r).into_owned())
        } else {
            None
        };
        if fields.len() != count || fields[1].len() != 2 {
            continue;
        }
        let mut xy = fields[1].chars();
        let index = xy.next().unwrap_or('.');
        let worktree = xy.next().unwrap_or('.');
        result.files.push(FileStatus {
            path: fields[count - 1].into(),
            original_path: original,
            index,
            worktree,
            staged: index != '.',
            unstaged: worktree != '.',
            untracked: false,
            renamed: index == 'R' || worktree == 'R',
            conflicted: raw.first() == Some(&b'u'),
        });
    }
    result
}
/// Tracked line-count changes from a merge base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Current file path.
    pub path: String,
    /// Added lines, zero for binary files.
    pub added: u64,
    /// Removed lines, zero for binary files.
    pub removed: u64,
    /// Git reported binary content.
    pub is_binary: bool,
    /// Git status letter (filled by the caller from name-status).
    pub status: String,
}
/// Parse `diff --numstat -z --no-renames` output; tabs in names are preserved.
pub fn parse_numstat(input: &[u8]) -> Vec<ChangedFile> {
    input
        .split(|b| *b == 0)
        .filter_map(|r| {
            let text = String::from_utf8_lossy(r);
            let mut fields = text.splitn(3, '\t');
            let a = fields.next()?;
            let d = fields.next()?;
            let path = fields.next()?;
            let is_binary = a == "-" && d == "-";
            Some(ChangedFile {
                path: path.into(),
                added: if is_binary { 0 } else { a.parse().ok()? },
                removed: if is_binary { 0 } else { d.parse().ok()? },
                is_binary,
                status: String::new(),
            })
        })
        .collect()
}
