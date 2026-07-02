use anyhow::{Context, Result};
use pnlx_risc0_batch_match_core::ProofRequest;
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

#[derive(Serialize)]
struct ProofOutput {
    image_id: String,
    journal_digest: String,
    journal_path: String,
    seal_digest: String,
    seal_path: String,
}

fn main() -> Result<()> {
    let args = env::args().collect::<Vec<_>>();
    if args.len() != 3 {
        anyhow::bail!("usage: {} <input.json> <output-dir>", args[0]);
    }

    let input_path = PathBuf::from(&args[1]);
    let output_dir = PathBuf::from(&args[2]);
    fs::create_dir_all(&output_dir).context("create output directory")?;

    let input_bytes = fs::read(&input_path).context("read prover input")?;
    let request: ProofRequest = serde_json::from_slice(&input_bytes).context("parse prover input")?;

    let env = ExecutorEnv::builder()
        .write(&request)
        .context("write zkVM input")?
        .build()
        .context("build executor env")?;
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, pnlx_risc0_methods::BATCH_MATCH_ELF, &ProverOpts::groth16())
        .context("generate RISC0 Groth16 proof")?;
    let receipt = prove_info.receipt;
    receipt
        .verify(pnlx_risc0_methods::BATCH_MATCH_ID)
        .context("verify local RISC0 receipt")?;

    let seal = encode_seal(&receipt).context("encode RISC0 Groth16 seal")?;
    let journal = receipt.journal.bytes.clone();
    let journal_digest = Sha256::digest(&journal);
    let seal_digest = Sha256::digest(&seal);

    let journal_path = output_dir.join("journal.bin");
    let seal_path = output_dir.join("seal.bin");
    let metadata_path = output_dir.join("proof.json");
    fs::write(&journal_path, &journal).context("write journal")?;
    fs::write(&seal_path, &seal).context("write seal")?;

    let output = ProofOutput {
        image_id: format!("0x{}", hex::encode(image_id_bytes())),
        journal_digest: format!("0x{}", hex::encode(journal_digest)),
        journal_path: journal_path.display().to_string(),
        seal_digest: format!("0x{}", hex::encode(seal_digest)),
        seal_path: seal_path.display().to_string(),
    };
    fs::write(&metadata_path, serde_json::to_vec_pretty(&output)?).context("write proof metadata")?;
    println!("{}", metadata_path.display());
    Ok(())
}

fn image_id_bytes() -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, word) in pnlx_risc0_methods::BATCH_MATCH_ID.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}
