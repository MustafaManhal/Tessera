//! Best-effort TCP listeners. macOS can query accessible process cwd through lsof.
//! Windows matches netstat listener PIDs to the live task sessions and their descendants.
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

fn endpoint_port(endpoint: &str) -> Option<u16> {
    let port = endpoint.rsplit_once(':')?.1.parse().ok()?;
    if port == 0 { None } else { Some(port) }
}
/// Parse macOS lsof tabular TCP LISTEN output for only the supplied process tree.
pub fn parse_lsof(input: &str, pids: &[u32]) -> Vec<u16> {
    let mut ports = BTreeSet::new();
    for line in input.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.last() != Some(&"(LISTEN)") {
            continue;
        }
        let Some(pid) = fields.get(1).and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if !pids.contains(&pid) {
            continue;
        }
        if let Some(index) = fields.iter().position(|s| *s == "TCP")
            && let Some(port) = fields.get(index + 1).and_then(|s| endpoint_port(s))
        {
            ports.insert(port);
        }
    }
    ports.into_iter().collect()
}
/// Parse Windows netstat -ano output for only the supplied process tree.
pub fn parse_netstat(input: &str, pids: &[u32]) -> Vec<u16> {
    let mut ports = BTreeSet::new();
    for line in input.lines() {
        let mut fields = line.split_whitespace();
        let (Some(protocol), Some(local), Some(_remote), Some(state), Some(pid), None) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        if (protocol.eq_ignore_ascii_case("TCP") || protocol.eq_ignore_ascii_case("TCPv6"))
            && state.eq_ignore_ascii_case("LISTENING")
            && pid.parse::<u32>().ok().is_some_and(|pid| pids.contains(&pid))
            && let Some(port) = endpoint_port(local)
        {
            ports.insert(port);
        }
    }
    ports.into_iter().collect()
}
/// Expand roots using PID/PPID rows; unknown/malformed rows never add processes.
pub fn descendant_pids(input: &str, roots: &[u32]) -> Vec<u32> {
    let pairs: Vec<_> = input
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse::<u32>().ok()?, fields.next()?.parse::<u32>().ok()?))
        })
        .collect();
    let mut found: BTreeSet<_> = roots.iter().copied().collect();
    loop {
        let before = found.len();
        for &(pid, parent) in &pairs {
            if found.contains(&parent) {
                found.insert(pid);
            }
        }
        if found.len() == before {
            break;
        }
    }
    found.into_iter().collect()
}
/// Read accessible process cwd records from lsof -d cwd -Fpn.
/// Prefix comparison is path-component aware and canonicalized on macOS by the caller.
pub fn cwd_pids(input: &str, root: &Path) -> Vec<u32> {
    let mut pid = None;
    let mut result = BTreeSet::new();
    for line in input.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        }
        if let Some(path) = line.strip_prefix('n')
            && Path::new(path).starts_with(root)
            && let Some(pid) = pid
        {
            result.insert(pid);
        }
    }
    result.into_iter().collect()
}
/// Query TCP listeners for a known process tree. Missing tools/permissions return no ports.
pub fn listening_ports(pid_tree: &[u32]) -> Vec<u16> {
    if pid_tree.is_empty() {
        return vec![];
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN"]).output();
        output
            .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout), pid_tree))
            .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        ["tcp", "tcpv6"]
            .into_iter()
            .filter_map(|protocol| {
                windows_command("netstat.exe")
                    .args(["-ano", "-p", protocol])
                    .output()
                    .ok()
            })
            .filter(|output| output.status.success())
            .flat_map(|output| parse_netstat(&String::from_utf8_lossy(&output.stdout), pid_tree))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        vec![]
    }
}
#[cfg(windows)]
fn windows_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let mut command = Command::new(std::path::PathBuf::from(system).join("System32").join(program));
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// Discovers Windows TCP listeners belonging to live session roots or their descendants.
#[cfg(windows)]
pub fn ports_for_session_roots(roots: &[u32]) -> Vec<u16> {
    if roots.is_empty() {
        return Vec::new();
    }
    let output = windows_command(r"WindowsPowerShell\v1.0\powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", r#"
            $ErrorActionPreference = 'Stop'
            Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 3 |
                ForEach-Object {
                    if ($_.CreationDate) {
                        '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks
                    }
                }
        "#])
        .output();
    let tree = match output {
        Ok(output) if output.status.success() => {
            windows_descendant_pids(&String::from_utf8_lossy(&output.stdout), roots)
        }
        Ok(output) => {
            tracing::debug!(status = %output.status, "Windows process tree command failed");
            roots.to_vec()
        }
        Err(error) => {
            tracing::debug!(%error, "Windows process tree unavailable");
            roots.to_vec()
        }
    };
    listening_ports(&tree)
}

// Windows parent PIDs are reusable. A parent created after its child cannot be that child's parent.
#[cfg(any(windows, test))]
fn windows_descendant_pids(input: &str, roots: &[u32]) -> Vec<u32> {
    use std::collections::BTreeMap;
    const MAX_ANCESTORS: usize = 64;
    let processes = input
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok().filter(|pid| *pid != 0)?;
            let parent = fields.next()?.parse::<u32>().ok()?;
            let created = fields.next()?.parse::<u64>().ok().filter(|time| *time != 0)?;
            fields.next().is_none().then_some((pid, (parent, created)))
        })
        .collect::<BTreeMap<_, _>>();
    let roots = roots.iter().copied().filter(|pid| *pid != 0).collect::<BTreeSet<_>>();
    let mut tree = roots.clone();
    for &pid in processes.keys() {
        let mut current = pid;
        for _ in 0..MAX_ANCESTORS {
            let Some(&(parent, created)) = processes.get(&current) else {
                break;
            };
            let Some(&(_, parent_created)) = processes.get(&parent) else {
                break;
            };
            if parent_created > created || parent == current {
                break;
            }
            if roots.contains(&parent) {
                tree.insert(pid);
                break;
            }
            current = parent;
        }
    }
    tree.into_iter().collect()
}

/// Discover processes whose cwd is within a task checkout, then include descendants.
/// On Windows use `ports_for_session_roots` with task session PIDs.
pub fn ports_in_worktree(root: &Path) -> Vec<u16> {
    #[cfg(target_os = "macos")]
    {
        let Ok(root) = std::fs::canonicalize(root) else {
            return vec![];
        };
        let Ok(output) = Command::new("lsof").args(["-nP", "-a", "-d", "cwd", "-Fpn"]).output() else {
            return vec![];
        };
        let roots = cwd_pids(&String::from_utf8_lossy(&output.stdout), &root);
        let tree = Command::new("ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .map(|o| descendant_pids(&String::from_utf8_lossy(&o.stdout), &roots))
            .unwrap_or(roots);
        listening_ports(&tree)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn macos_and_windows_fixtures_filter_garbage_foreign_pids_and_nonlisteners() {
        let mac = include_str!("../tests/fixtures/lsof-listen.txt");
        assert_eq!(parse_lsof(mac, &[41]), vec![1421, 9000]);
        assert_eq!(parse_lsof(mac, &[999]), Vec::<u16>::new());
        let win = include_str!("../tests/fixtures/netstat-listen.txt");
        assert_eq!(parse_netstat(win, &[41]), vec![1421, 9000]);
        assert_eq!(parse_netstat(win, &[999]), Vec::<u16>::new());
    }
    #[test]
    fn windows_walks_only_bounded_live_parent_chains() {
        let input = include_str!("../tests/fixtures/windows-process-tree.txt");
        let pids = windows_descendant_pids(input, &[41]);
        assert_eq!(pids, vec![41, 43, 44]);
        let output = "Connexions actives\r\n  Protocole   Adresse locale   Adresse distante   État   PID\r\n\t TCP  [::]:5000   [::]:0  Listening  44  \r\n  TCP 0.0.0.0:5001 0.0.0.0:0 LISTENING 42";
        assert_eq!(parse_netstat(output, &pids), vec![5000]);
        assert!(parse_netstat("", &pids).is_empty());
        assert!(windows_descendant_pids("", &[]).is_empty());

        let chain = (2..=70)
            .map(|pid| format!("{pid} {} {pid}", pid - 1))
            .collect::<Vec<_>>()
            .join("\n");
        let chain = format!("1 0 1\n{chain}");
        assert_eq!(windows_descendant_pids(&chain, &[1]), (1..=65).collect::<Vec<_>>());
    }

    #[test]
    fn cwd_and_descendants_are_component_aware_and_order_independent() {
        assert_eq!(
            cwd_pids(
                "p41\nfcwd\nn/repo/task\np42\nn/repo/task-other\npbad\nn/repo/task/sub\np43\nn/repo/task/sub",
                Path::new("/repo/task")
            ),
            vec![41, 43]
        );
        assert_eq!(descendant_pids("43 42\n42 41\n50 1\ngarbage", &[41]), vec![41, 42, 43]);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod live_tests {
    #[test]
    fn discovers_a_real_listener_owned_by_this_process() {
        if std::process::Command::new("lsof").arg("-v").output().is_err() {
            eprintln!("skip: lsof unavailable");
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("address").port();
        assert!(super::listening_ports(&[std::process::id()]).contains(&port));
        assert!(super::ports_in_worktree(&std::env::current_dir().expect("cwd")).contains(&port));
    }
}
