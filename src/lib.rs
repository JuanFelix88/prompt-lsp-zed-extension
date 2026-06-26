use std::{env, fs, path::Path};

use zed_extension_api::{self as zed, LanguageServerId, Result};

const SERVER_ID: &str = "prompt-markdown-lsp";
const SERVER_DIR: &str = "prompt-markdown-lsp";
const SERVER_SCRIPT_NAME: &str = "prompt-lsp.mjs";
const SERVER_SCRIPT: &str = include_str!("../lsp/prompt-lsp.mjs");

struct PromptLspExtension;

impl PromptLspExtension {
    fn write_server_script() -> Result<String> {
        fs::create_dir_all(SERVER_DIR)
            .map_err(|e| format!("Failed to create language server directory: {e}"))?;

        let script_rel = format!("{SERVER_DIR}/{SERVER_SCRIPT_NAME}");
        fs::write(&script_rel, SERVER_SCRIPT)
            .map_err(|e| format!("Failed to write language server script: {e}"))?;

        Ok(env::current_dir()
            .map_err(|e| format!("Failed to get extension work dir: {e}"))?
            .join(Path::new(&script_rel))
            .to_string_lossy()
            .into_owned())
    }
}

impl zed::Extension for PromptLspExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!("Unknown language server: {language_server_id}"));
        }

        let server_script = Self::write_server_script()?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_script, "--workspace".into(), worktree.root_path()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(PromptLspExtension);
