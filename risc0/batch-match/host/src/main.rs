use anyhow::{anyhow, Context, Result};
use clap::Parser;
use pnlx_risc0_batch_match_core::{prove_request, ProofRequest};
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::{
    compute_image_id, default_executor, default_prover, sha::Digest, ExecutorEnv, Prover,
    ProverOpts, Receipt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};
use std::{env, fs, path::PathBuf, str::FromStr, time::Instant};
use tracing_subscriber::{filter::LevelFilter, prelude::*, EnvFilter};

mod request_journal;
use request_journal::{lock_job, write_atomic};

const DEFAULT_BATCH_MATCH_CYCLES: u64 = 100_000_000;
const GROTH16_SEAL_BYTES: usize = 260;
const MIN_SEGMENT_PO2: u32 = 13;
const MAX_SEGMENT_PO2: u32 = 24;

#[derive(Parser, Debug)]
#[clap(
    author,
    version,
    about = "Prove a PNLX batch-match settlement locally with a RISC Zero Groth16 seal"
)]
struct Args {
    input_path: Option<PathBuf>,
    output_dir: Option<PathBuf>,

    #[clap(long)]
    print_image_id: bool,

    #[clap(long)]
    print_program_path: bool,

    #[clap(long)]
    preflight_only: bool,
}

#[derive(Serialize)]
struct ProofOutput {
    image_id: String,
    journal_digest: String,
    journal_path: String,
    seal_digest: String,
    seal_path: String,
}

struct GuestProgram {
    bytes: Vec<u8>,
    image_id: Digest,
    path: PathBuf,
}

impl GuestProgram {
    fn load(path: Option<PathBuf>) -> Result<Self> {
        let (bytes, path) = match path {
            Some(path) => (
                fs::read(&path).context("read configured guest program")?,
                path,
            ),
            None => (
                pnlx_risc0_methods::BATCH_MATCH_ELF.to_vec(),
                PathBuf::from(pnlx_risc0_methods::BATCH_MATCH_PATH),
            ),
        };
        let image_id = compute_image_id(&bytes).context("compute guest program image ID")?;
        Ok(Self {
            bytes,
            image_id,
            path,
        })
    }

    fn verify_pin(&self) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Pin {
            image_id: String,
        }
        let pin: Pin = serde_json::from_str(include_str!("../../image-id.json"))?;
        verify_image_id(self.image_id, &pin.image_id)?;
        if let Ok(expected) = env::var("PNLX_EXPECTED_BATCH_MATCH_IMAGE_ID") {
            verify_image_id(self.image_id, &expected)?;
        }
        Ok(())
    }
}

fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::from_str("info")?.into())
                .from_env_lossy(),
        )
        .init();

    let args = Args::parse();
    let program =
        GuestProgram::load(env::var_os("RISC0_BATCH_MATCH_PROGRAM_PATH").map(PathBuf::from))?;
    if args.print_image_id {
        println!("0x{}", program.image_id);
        return Ok(());
    }
    if args.print_program_path {
        println!("{}", program.path.display());
        return Ok(());
    }
    let input_path = args
        .input_path
        .clone()
        .ok_or_else(|| anyhow!("INPUT_PATH is required unless an inspection flag is used"))?;
    let output_dir = args
        .output_dir
        .clone()
        .ok_or_else(|| anyhow!("OUTPUT_DIR is required unless an inspection flag is used"))?;
    run(args, program, input_path, output_dir)
}

fn run(args: Args, program: GuestProgram, input_path: PathBuf, output_dir: PathBuf) -> Result<()> {
    reject_dev_mode()?;
    guard_prover_selection()?;
    program.verify_pin()?;
    fs::create_dir_all(&output_dir).context("create output directory")?;
    let _job_lock = lock_job(&output_dir)?;

    let input_bytes = fs::read(&input_path).context("read prover input")?;
    let request: ProofRequest =
        serde_json::from_slice(&input_bytes).context("parse prover input")?;
    let proved = prove_request(&request);

    let cycles = preflight(&program.bytes, &request, &proved.journal)?;
    if args.preflight_only {
        println!("preflight cycles: {cycles}");
        return Ok(());
    }
    tracing::info!("batch-match preflight completed in {cycles} cycles");

    let receipt = prove_groth16(&program, &request)?;
    if receipt.journal.bytes != proved.journal {
        anyhow::bail!("prover journal does not match expected batch public input bytes");
    }

    let seal = encode_seal(&receipt).context("encode Groth16 on-chain seal")?;
    validate_groth16_seal(&seal)?;
    let journal_path = output_dir.join("journal.bin");
    let seal_path = output_dir.join("seal.bin");
    let metadata_path = output_dir.join("proof.json");
    write_atomic(&output_dir, "journal.bin", &proved.journal)?;
    write_atomic(&output_dir, "seal.bin", &seal)?;

    let output = ProofOutput {
        image_id: format!("0x{}", hex::encode(program.image_id.as_bytes())),
        journal_digest: format!("0x{}", hex::encode(Sha256::digest(&proved.journal))),
        journal_path: journal_path.display().to_string(),
        seal_digest: format!("0x{}", hex::encode(Sha256::digest(&seal))),
        seal_path: seal_path.display().to_string(),
    };
    write_atomic(
        &output_dir,
        "proof.json",
        &serde_json::to_vec_pretty(&output)?,
    )?;
    println!("{}", metadata_path.display());
    Ok(())
}

fn prove_groth16(program: &GuestProgram, request: &ProofRequest) -> Result<Receipt> {
    let mut builder = ExecutorEnv::builder();
    builder.write(request).context("encode zkVM proving input")?;
    if let Some(po2) = configured_segment_po2()? {
        builder.segment_limit_po2(po2);
    }
    let env = builder.build().context("build zkVM proving environment")?;
    let opts = ProverOpts::groth16();
    let started = Instant::now();
    let info = default_prover()
        .prove_with_opts(env, &program.bytes, &opts)
        .context("prove batch-match guest locally")?;
    let proving_elapsed = started.elapsed();
    let receipt = info.receipt;
    receipt
        .verify(program.image_id)
        .context("verify locally produced batch-match receipt")?;
    tracing::info!("batch-match Groth16 proof completed in {proving_elapsed:?}");
    Ok(receipt)
}

fn preflight(program: &[u8], request: &ProofRequest, expected_journal: &[u8]) -> Result<u64> {
    let env = ExecutorEnv::builder()
        .write(request)
        .context("encode zkVM preflight input")?
        .build()
        .context("build zkVM preflight environment")?;
    let session = default_executor()
        .execute(env, program)
        .context("execute batch-match guest preflight")?;
    if session.journal.bytes != expected_journal {
        anyhow::bail!("RISC0 guest preflight journal does not match expected batch output");
    }
    let cycles = session.cycles();
    let limit = batch_match_cycles()?;
    if cycles > limit {
        anyhow::bail!("RISC0 guest needs {cycles} cycles but the request limit is {limit}");
    }
    Ok(cycles)
}

fn validate_groth16_seal(seal: &[u8]) -> Result<()> {
    if seal.len() != GROTH16_SEAL_BYTES {
        anyhow::bail!(
            "prover returned a malformed Groth16 seal: expected {} bytes, received {}",
            GROTH16_SEAL_BYTES,
            seal.len()
        );
    }
    if seal.iter().all(|byte| *byte == 0) {
        anyhow::bail!("prover returned an all-zero Groth16 seal");
    }
    Ok(())
}

fn reject_dev_mode() -> Result<()> {
    let enabled = env::var("RISC0_DEV_MODE")
        .ok()
        .map(|value| {
            let normalized = value.to_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        })
        .unwrap_or(false);
    if enabled {
        anyhow::bail!("RISC0_DEV_MODE must be disabled for Groth16 batch-match proving");
    }
    Ok(())
}

fn guard_prover_selection() -> Result<()> {
    match env::var("RISC0_PROVER") {
        Ok(value) if value.eq_ignore_ascii_case("local") => Ok(()),
        Ok(value) => Err(anyhow!(
            "RISC0_PROVER={value} is not supported; unset it or set RISC0_PROVER=local"
        )),
        Err(_) => Ok(()),
    }?;
    for variable in ["BONSAI_API_URL", "BONSAI_API_KEY"] {
        if env::var_os(variable).is_some() {
            anyhow::bail!(
                "{variable} is set; remote Bonsai proving is retired, unset it to prove locally"
            );
        }
    }
    Ok(())
}

fn configured_segment_po2() -> Result<Option<u32>> {
    let raw = match env::var("PNLX_SEGMENT_PO2") {
        Ok(raw) => raw,
        Err(env::VarError::NotPresent) => return Ok(None),
        Err(error) => return Err(error).context("read PNLX_SEGMENT_PO2"),
    };
    let po2 = raw
        .trim()
        .parse::<u32>()
        .with_context(|| format!("parse PNLX_SEGMENT_PO2={raw}"))?;
    if !(MIN_SEGMENT_PO2..=MAX_SEGMENT_PO2).contains(&po2) {
        anyhow::bail!(
            "PNLX_SEGMENT_PO2={po2} is outside the supported {MIN_SEGMENT_PO2}..={MAX_SEGMENT_PO2} range"
        );
    }
    Ok(Some(po2))
}

fn verify_image_id(image_id: Digest, expected: &str) -> Result<()> {
    let actual = format!("0x{image_id}");
    if !actual.eq_ignore_ascii_case(expected) {
        anyhow::bail!("batch-match guest image ID does not match the pinned deployment image ID: expected {expected}, built {actual}");
    }
    Ok(())
}

fn batch_match_cycles() -> Result<u64> {
    match env::var("RISC0_BATCH_MATCH_CYCLES") {
        Ok(raw) => raw
            .parse()
            .with_context(|| format!("parse RISC0_BATCH_MATCH_CYCLES={raw}")),
        Err(env::VarError::NotPresent) => Ok(DEFAULT_BATCH_MATCH_CYCLES),
        Err(error) => Err(error).context("read RISC0_BATCH_MATCH_CYCLES"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_program_uses_its_actual_image_and_rejects_a_wrong_pin() {
        let program =
            GuestProgram::load(Some(PathBuf::from(pnlx_risc0_methods::BATCH_MATCH_PATH))).unwrap();
        assert_eq!(program.image_id, compute_image_id(&program.bytes).unwrap());
        assert!(verify_image_id(program.image_id, &format!("0x{}", program.image_id)).is_ok());
        assert!(verify_image_id(program.image_id, &format!("0x{}", "00".repeat(32))).is_err());
        assert!(GuestProgram::load(Some(PathBuf::from("/no-such-pnlx-guest"))).is_err());
    }

    #[test]
    fn groth16_seal_validation_enforces_length_and_nonzero_bytes() {
        let mut seal = vec![0u8; GROTH16_SEAL_BYTES];
        assert!(validate_groth16_seal(&seal).is_err());
        seal[0] = 0x73;
        assert!(validate_groth16_seal(&seal).is_ok());
        seal.push(0);
        assert!(validate_groth16_seal(&seal).is_err());
        seal.truncate(GROTH16_SEAL_BYTES - 1);
        assert!(validate_groth16_seal(&seal).is_err());
    }

    #[test]
    fn segment_po2_configuration_rejects_out_of_range_values() {
        assert!(configured_segment_po2().unwrap().is_none());
        std::env::set_var("PNLX_SEGMENT_PO2", "18");
        assert_eq!(configured_segment_po2().unwrap(), Some(18));
        std::env::set_var("PNLX_SEGMENT_PO2", "12");
        assert!(configured_segment_po2().is_err());
        std::env::set_var("PNLX_SEGMENT_PO2", "25");
        assert!(configured_segment_po2().is_err());
        std::env::set_var("PNLX_SEGMENT_PO2", "not-a-number");
        assert!(configured_segment_po2().is_err());
        std::env::remove_var("PNLX_SEGMENT_PO2");
    }

    #[test]
    fn only_the_local_prover_selection_is_accepted() {
        std::env::remove_var("BONSAI_API_URL");
        std::env::remove_var("BONSAI_API_KEY");
        std::env::set_var("RISC0_PROVER", "local");
        assert!(guard_prover_selection().is_ok());
        std::env::set_var("RISC0_PROVER", "ipc");
        assert!(guard_prover_selection().is_err());
        std::env::remove_var("RISC0_PROVER");
        assert!(guard_prover_selection().is_ok());
        std::env::set_var("BONSAI_API_URL", "https://example.invalid");
        assert!(guard_prover_selection().is_err());
        std::env::remove_var("BONSAI_API_URL");
    }
}
