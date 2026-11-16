//! Generate a documentation-derived hook fixture without writing the input file.
//! cargo run -p tessera-agents --example hooks_fixture -- claude-settings fixtures/hooks/claude/settings.before.json.fixture
use tessera_agents::hooks::{Action, Kind, Ownership, plan};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let kind = Kind::parse(&args[1]).unwrap();
    let text = std::fs::read_to_string(&args[2]).unwrap();
    let result = plan(kind, &text, "/fixture/tessera", Action::Install, &Ownership::default()).unwrap();
    print!("{}", result.after);
}
