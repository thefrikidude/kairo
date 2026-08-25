use std::{env, fs, path::PathBuf};

use crate::{KairoError, Result};

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    root: PathBuf,
}

impl RuntimePaths {
    pub fn discover() -> Result<Self> {
        let root = match env::var_os("KAIRO_HOME") {
            Some(path) => PathBuf::from(path),
            None => match env::var_os("XDG_RUNTIME_DIR") {
                Some(path) => PathBuf::from(path).join("kairo"),
                None => home_dir()?.join(".kairo"),
            },
        };

        if !root.is_absolute() {
            return Err(KairoError::InvalidArguments(
                "KAIRO_HOME must be an absolute path".to_owned(),
            ));
        }

        Ok(Self { root })
    }

    pub fn ensure_exists(&self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        Ok(())
    }

    pub fn socket_path(&self) -> PathBuf {
        self.root.join("runtime.sock")
    }

    pub fn database_path(&self) -> PathBuf {
        self.root.join("kairo.sqlite3")
    }
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| KairoError::InvalidArguments("HOME is not set".to_owned()))
}
