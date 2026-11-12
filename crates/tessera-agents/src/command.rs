use crate::AgentDefinition;
use std::collections::BTreeMap;
/// Plain environment overrides, persisted without encryption. Do not store secrets here.
#[derive(Debug, Clone, Default)]
pub struct LaunchProfile {
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub skip_permissions: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLine {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub type_after_ready: Option<String>,
    pub env: BTreeMap<String, String>,
}
pub fn command_line(
    definition: &AgentDefinition,
    profile: &LaunchProfile,
    prompt: Option<&str>,
) -> Result<CommandLine, String> {
    definition.validate()?;
    // Reject bypass flags smuggled through extra args rather than implicitly enabling them.
    if !profile.skip_permissions
        && profile.extra_args.iter().any(|arg| {
            definition
                .yolo_flags
                .iter()
                .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
        })
    {
        return Err("Permission-skipping arguments require the profile permission switch.".into());
    }
    let mut result = CommandLine {
        program: definition.binaries[0].clone(),
        args: vec![],
        stdin: None,
        type_after_ready: None,
        env: profile.env.clone(),
    };
    if let Some(model) = &profile.model {
        let flag = definition
            .model_flag
            .as_ref()
            .ok_or("This agent does not have a confirmed model flag.")?;
        result.args.extend([flag.clone(), model.clone()]);
    }
    result.args.extend(profile.extra_args.clone());
    if profile.skip_permissions {
        result.args.extend(definition.yolo_flags.clone());
    }
    if let Some(prompt) = prompt {
        match definition.prompt_mode.as_str() {
            "arg" => {
                result.args.push("--".into());
                result.args.push(prompt.into());
            }
            "stdin" => result.stdin = Some(prompt.into()),
            "type" => result.type_after_ready = Some(prompt.into()),
            mode => {
                result.args.push(mode.trim_start_matches("flag:").into());
                result.args.push(prompt.into());
            }
        }
    }
    Ok(result)
}
