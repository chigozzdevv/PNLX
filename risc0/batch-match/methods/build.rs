use risc0_build::{DockerOptionsBuilder, GuestOptionsBuilder};
use std::{collections::HashMap, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PNLX_RISC0_REPRODUCIBLE_BUILD");
    if std::env::var("PNLX_RISC0_REPRODUCIBLE_BUILD").as_deref() == Ok("0") {
        risc0_build::embed_methods();
        return;
    }

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let docker = DockerOptionsBuilder::default()
        .root_dir(root)
        .build()
        .expect("build reproducible RISC0 Docker options");
    let guest = GuestOptionsBuilder::default()
        .use_docker(docker)
        .build()
        .expect("build reproducible RISC0 guest options");
    let mut options = HashMap::new();
    options.insert("guest", guest);
    risc0_build::embed_methods_with_options(options);
}
