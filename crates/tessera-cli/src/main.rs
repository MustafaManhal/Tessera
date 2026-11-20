//! Local app control. Hook mode is best effort, silent, and bounded even when stdin never closes.
mod mcp;
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tessera_api::{Endpoint, MAX_LINE};
#[derive(Parser)]
#[command(name = "tessera", version, about = "Control the running Tessera app.")]
struct Args {
    /// Use Tessera Dev instead of Tessera when no explicit endpoint is supplied.
    #[arg(long, global = true)]
    dev: bool,
    /// Print the raw JSON-RPC result instead of the human-readable summary.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Print the running app version and API version.
    Info,
    /// Serve MCP over stdio for agents. Disabled unless enabled in Settings.
    Mcp {
        /// Bypass the opt-in check for tests.
        #[arg(long)]
        force: bool,
    },
    /// Manage registered projects.
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Create, list, archive and delete tasks.
    Task {
        #[command(subcommand)]
        command: TaskCommand,
    },
    /// Read agent status, wait for it, or send it input.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Read a pane's scrollback.
    Pane {
        #[command(subcommand)]
        command: PaneCommand,
    },
    /// Show a task's diff against its base branch.
    Review {
        #[command(subcommand)]
        command: ReviewCommand,
    },
    /// Forward agent hook JSON. Always succeeds silently, within two seconds.
    Hook { event: String, payload: Option<String> },
    /// Send an operating-system notification through the app.
    Notify { title: String, body: String },
}
#[derive(Subcommand)]
enum ProjectCommand {
    /// List registered projects.
    Ls,
    /// Add a local repository folder.
    Add { path: String },
}
#[derive(Subcommand)]
enum TaskCommand {
    /// List tasks, optionally filtered by project or state.
    Ls {
        /// Project id, slug or path.
        #[arg(long)]
        project: Option<String>,
        /// Task state filter (backlog, setting_up, active, archived, error).
        #[arg(long)]
        status: Option<String>,
    },
    /// Create a task and optionally start agents with the prompt.
    New {
        /// Project id, slug or path. Defaults to the only registered project.
        #[arg(long)]
        project: Option<String>,
        /// Agent id to start (repeatable, for example --agent claude --agent codex).
        #[arg(long = "agent")]
        agents: Vec<String>,
        /// Base branch or revision.
        #[arg(long)]
        base: Option<String>,
        /// Display name.
        #[arg(long)]
        name: Option<String>,
        /// The prompt given to the task and its agents.
        prompt: String,
    },
    /// Archive a task without deleting its files.
    Archive { task: String },
    /// Delete a task's worktree and branch.
    Rm {
        task: String,
        /// Confirm deleting unmerged commits or a dirty worktree.
        #[arg(long)]
        confirm: bool,
    },
}
#[derive(Subcommand)]
enum AgentCommand {
    /// Print the newest agent session's status for a task.
    Status { task: String },
    /// Block until the agent reaches one of the given statuses.
    Wait {
        task: String,
        /// Status to wait for (repeatable): starting, working, needs_input, idle, error, exited.
        #[arg(long = "status", required = true)]
        statuses: Vec<String>,
        /// Timeout in seconds.
        #[arg(long, default_value_t = 600)]
        timeout: u64,
    },
    /// Send text to the task's agent pane and submit it with Enter.
    Send { task: String, text: String },
}
#[derive(Subcommand)]
enum PaneCommand {
    /// Print the last lines of a task's agent pane (or a session id with --session).
    Read {
        /// Task id, slug or name.
        task: String,
        /// Read a PTY or agent session id instead of a task.
        #[arg(long)]
        session: Option<String>,
        /// Number of lines (default 200, max 5000).
        #[arg(long, default_value_t = 200)]
        lines: usize,
    },
}
#[derive(Subcommand)]
enum ReviewCommand {
    /// Print the task's unified diff against its base branch.
    Diff { task: String },
}
fn main() {
    // `ssh` runs this binary as SSH_ASKPASS with the prompt as the only argument (see ssh_commands.rs in the app).
    if let Some(alias) = std::env::var_os("TESSERA_ASKPASS_ALIAS") {
        let prompt = std::env::args().nth(1).unwrap_or_default();
        std::process::exit(askpass(&alias.to_string_lossy(), &prompt));
    }
    let args = Args::parse();
    if let Command::Hook { event, payload } = args.command {
        hook(args.dev, event, payload);
        return;
    }
    if let Command::Mcp { force } = args.command {
        if let Err(error) = mcp::run(args.dev, force) {
            eprintln!("tessera mcp: {error}");
            std::process::exit(2);
        }
        return;
    }
    let plan = plan(&args);
    // `agent wait` gets its timeout plus slack; review diffs can run several git commands.
    let timeout = match plan.method {
        "agent.wait" => Duration::from_millis(plan.timeout_ms.unwrap_or(300_000)) + Duration::from_secs(15),
        "review.diff" => Duration::from_secs(120),
        _ => Duration::from_secs(30),
    };
    let result = Endpoint::from_environment(args.dev)
        .map_err(|_| "The API endpoint could not be resolved.".to_string())
        .and_then(|endpoint| {
            tessera_api::call(endpoint, plan.method.to_string(), plan.params(), timeout).map_err(|e| e.message)
        });
    match result {
        Ok(value) => {
            if args.json {
                println!("{}", serde_json::to_string(&value).unwrap());
            } else {
                plan.human(&value);
            }
            // `agent wait` exits 3 when the timeout expired before a wanted status appeared.
            if plan.method == "agent.wait" && value["timed_out"].as_bool() == Some(true) {
                std::process::exit(3);
            }
        }
        Err(error) => {
            eprintln!("tessera: {error}");
            std::process::exit(2);
        }
    }
}
struct Plan {
    method: &'static str,
    params: Value,
    /// `agent.wait` only: the server-side timeout in milliseconds.
    timeout_ms: Option<u64>,
}
impl Plan {
    fn params(&self) -> Value {
        self.params.clone()
    }
    /// Renders the human-readable form.
    fn human(&self, value: &Value) {
        match self.method {
            "app.info" => {
                println!("Tessera {} (API {})", value["version"], value["api_version"]);
            }
            "project.list" => {
                for project in value.as_array().into_iter().flatten() {
                    println!("{}\t{}\t{}", project["name"], project["path"], project["id"]);
                }
            }
            "project.add" => {
                println!("{}\t{}\t{}", value["name"], value["path"], value["id"]);
            }
            "task.list" => {
                for task in value.as_array().into_iter().flatten() {
                    println!(
                        "{}\t{}\t{}\t{}",
                        task["id"], task["state"], task["name"], task["branch"]
                    );
                }
            }
            "task.create" => {
                for task in value["tasks"].as_array().into_iter().flatten() {
                    println!("{}\t{}", task["id"], task["name"]);
                }
                for agent in value["agents"].as_array().into_iter().flatten() {
                    if let Some(error) = agent["error"].as_str() {
                        eprintln!("tessera: agent {} failed: {error}", agent["agent"]);
                    }
                }
            }
            "agent.status" => {
                println!(
                    "{}\t{}",
                    value["status"].as_str().unwrap_or("unknown"),
                    value["message"].as_str().unwrap_or("")
                );
            }
            "agent.wait" => {
                println!("{}", value["status"].as_str().unwrap_or("unknown"));
            }
            "pane.read" => {
                println!("{}", value["text"].as_str().unwrap_or(""));
            }
            "review.diff" => {
                print!("{}", value["patch"].as_str().unwrap_or(""));
            }
            _ => {}
        }
    }
}
fn plan(args: &Args) -> Plan {
    match &args.command {
        Command::Info => Plan {
            method: "app.info",
            params: json!({}),
            timeout_ms: None,
        },
        Command::Notify { title, body } => Plan {
            method: "app.notify",
            params: json!({"title": title, "body": body}),
            timeout_ms: None,
        },
        Command::Project { command } => match command {
            ProjectCommand::Ls => Plan {
                method: "project.list",
                params: json!({}),
                timeout_ms: None,
            },
            ProjectCommand::Add { path } => Plan {
                method: "project.add",
                params: json!({"path": path}),
                timeout_ms: None,
            },
        },
        Command::Task { command } => match command {
            TaskCommand::Ls { project, status } => Plan {
                method: "task.list",
                params: json!({"project": project, "status": status}),
                timeout_ms: None,
            },
            TaskCommand::New {
                project,
                agents,
                base,
                name,
                prompt,
            } => Plan {
                method: "task.create",
                params: json!({
                    "project": project.clone().unwrap_or_default(),
                    "prompt": prompt,
                    "agents": agents,
                    "base": base,
                    "name": name,
                }),
                timeout_ms: None,
            },
            TaskCommand::Archive { task } => Plan {
                method: "task.archive",
                params: json!({"task": task}),
                timeout_ms: None,
            },
            TaskCommand::Rm { task, confirm } => Plan {
                method: "task.delete",
                params: json!({"task": task, "confirm_lost_commits": confirm}),
                timeout_ms: None,
            },
        },
        Command::Agent { command } => match command {
            AgentCommand::Status { task } => Plan {
                method: "agent.status",
                params: json!({"task": task}),
                timeout_ms: None,
            },
            AgentCommand::Wait {
                task,
                statuses,
                timeout,
            } => Plan {
                method: "agent.wait",
                params: json!({
                    "task": task,
                    "statuses": statuses,
                    "timeout_ms": timeout.saturating_mul(1000),
                }),
                timeout_ms: Some(timeout.saturating_mul(1000)),
            },
            AgentCommand::Send { task, text } => Plan {
                method: "agent.send",
                params: json!({"task": task, "text": text}),
                timeout_ms: None,
            },
        },
        Command::Pane { command } => match command {
            PaneCommand::Read { task, session, lines } => Plan {
                method: "pane.read",
                params: if let Some(session) = session {
                    json!({"session": session, "lines": lines})
                } else {
                    json!({"task": task, "lines": lines})
                },
                timeout_ms: None,
            },
        },
        Command::Review { command } => match command {
            ReviewCommand::Diff { task } => Plan {
                method: "review.diff",
                params: json!({"task": task}),
                timeout_ms: None,
            },
        },
        Command::Hook { .. } | Command::Mcp { .. } => unreachable!(),
    }
}
fn hook(dev: bool, event: String, payload: Option<String>) {
    let Ok(session) = std::env::var("TESSERA_SESSION_ID") else {
        return;
    };
    if session.is_empty() {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut bytes = Vec::new();
            if let Some(payload) = payload {
                bytes = payload.into_bytes();
            } else {
                io::stdin()
                    .lock()
                    .take((MAX_LINE + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Hook input could not be read.")?;
            }
            if bytes.len() > MAX_LINE {
                return Err("Hook input exceeds 1 MiB.".into());
            }
            let payload: Value = serde_json::from_slice(&bytes).map_err(|_| "Hook input is not valid JSON.")?;
            let endpoint = Endpoint::from_environment(dev).map_err(|_| "The API endpoint could not be resolved.")?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("The hook timed out.".into());
            }
            let at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
                .unwrap_or(0);
            tessera_api::call(endpoint,"hook.event".into(),json!({"tessera_session_id":session,"agent":std::env::var("TESSERA_AGENT").unwrap_or_default(),"event":event,"payload":payload,"at":at}),remaining).map_err(|e|e.message)?;
            Ok(())
        })();
        let _ = tx.send(result);
    });
    let result = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or_else(|_| Err("The hook timed out.".into()));
    if std::env::var_os("TESSERA_DEBUG").is_some()
        && let Err(error) = result
    {
        eprintln!("tessera hook: {error}");
    }
}

/// Keychain service of saved SSH passwords (the app's `ssh_commands::KEYCHAIN_SERVICE`).
const SSH_KEYCHAIN_SERVICE: &str = "Tessera SSH";

/// Answers ssh's password prompt from the keychain; every other prompt (a host key question, a key passphrase) gets
/// no answer and exit 1, so ssh never proceeds on something the user did not confirm.
fn askpass(alias: &str, prompt: &str) -> i32 {
    // TESSERA_ASKPASS_DEBUG=1 traces the decision on stderr (never the password), for the Windows proof workflow.
    let debug = std::env::var_os("TESSERA_ASKPASS_DEBUG").is_some();
    if !is_password_prompt(prompt) {
        if debug {
            eprintln!("askpass: not a password prompt: {prompt:?}");
        }
        return 1;
    }
    match keyring::Entry::new(SSH_KEYCHAIN_SERVICE, alias).and_then(|entry| entry.get_password()) {
        Ok(password) => {
            if debug {
                eprintln!(
                    "askpass: answering {prompt:?} for {alias} with {} characters",
                    password.chars().count()
                );
            }
            println!("{password}");
            0
        }
        Err(error) => {
            if debug {
                eprintln!("askpass: keychain read for {alias} failed: {error}");
            }
            1
        }
    }
}

/// `user@host's password:` and `Password:` style prompts; not passphrases, not yes/no questions.
fn is_password_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("password") && !lower.contains("passphrase") && !lower.contains("(yes/no")
}

#[cfg(test)]
mod askpass_tests {
    use super::*;

    #[test]
    fn only_password_prompts_are_answered() {
        assert!(is_password_prompt("me@box's password: "));
        assert!(is_password_prompt("Password:"));
        assert!(!is_password_prompt("Enter passphrase for key '/k/id': "));
        assert!(!is_password_prompt(
            "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        ));
        assert_eq!(askpass("unused", "Are you sure (yes/no)?"), 1);
    }
}
