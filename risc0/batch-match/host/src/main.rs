use alloy::{primitives::U256, signers::local::PrivateKeySigner};
use anyhow::{anyhow, Context, Result};
use boundless_market::{
    input::GuestEnv,
    price_oracle::{Amount, Asset},
    request_builder::OfferParams,
    Client, Deployment, StorageUploaderConfig,
};
use clap::Parser;
use pnlx_risc0_batch_match_core::{prove_request, ProofRequest};
use risc0_zkvm::{sha::Digest, Journal};
use serde::Serialize;
use sha2::{Digest as ShaDigest, Sha256};
use std::{env, fs, path::PathBuf, str::FromStr, time::Duration};
use tracing_subscriber::{filter::LevelFilter, prelude::*, EnvFilter};
use url::Url;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_INLINE_INPUT_BYTES: usize = 64 * 1024;
const DEFAULT_BATCH_MATCH_CYCLES: u64 = 10_000_000;
const DEFAULT_MIN_PRICE_WEI: u64 = 0;
const DEFAULT_MAX_PRICE_WEI: u64 = 60_000_000_000_000;
const DEFAULT_LOCK_COLLATERAL_ZKC_WEI: u64 = 5_000_000_000_000_000_000;
const GROTH16_SEAL_BYTES: usize = 260;

#[derive(Parser, Debug)]
#[clap(
    author,
    version,
    about = "Submit a PNLX batch-match Groth16 proof request to Boundless"
)]
struct Args {
    input_path: Option<PathBuf>,
    output_dir: Option<PathBuf>,

    #[clap(long)]
    print_image_id: bool,

    #[clap(long)]
    print_program_path: bool,

    #[clap(long, env = "BOUNDLESS_RPC_URL")]
    rpc_url: Option<Url>,

    #[clap(long, env = "BOUNDLESS_PRIVATE_KEY")]
    private_key: Option<PrivateKeySigner>,

    #[clap(long, env = "BOUNDLESS_PROGRAM_URL")]
    program_url: Option<Url>,

    #[clap(flatten, next_help_heading = "Storage Uploader")]
    storage_config: StorageUploaderConfig,

    #[clap(flatten, next_help_heading = "Boundless Market Deployment")]
    deployment: Option<Deployment>,
}

#[derive(Serialize)]
struct ProofOutput {
    image_id: String,
    journal_digest: String,
    journal_path: String,
    seal_digest: String,
    seal_path: String,
}

#[derive(Serialize)]
struct RequestOutput {
    expires_at: u64,
    request_id: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::from_str("info")?.into())
                .from_env_lossy(),
        )
        .init();

    let mut args = Args::parse();
    if args.print_image_id {
        println!("0x{}", hex::encode(image_id_bytes()));
        return Ok(());
    }
    if args.print_program_path {
        println!("{}", pnlx_risc0_methods::BATCH_MATCH_PATH);
        return Ok(());
    }
    let input_path = args
        .input_path
        .take()
        .ok_or_else(|| anyhow!("INPUT_PATH is required unless an inspection flag is used"))?;
    let output_dir = args
        .output_dir
        .take()
        .ok_or_else(|| anyhow!("OUTPUT_DIR is required unless an inspection flag is used"))?;
    args.input_path = Some(input_path);
    args.output_dir = Some(output_dir);
    run(args).await
}

async fn run(args: Args) -> Result<()> {
    reject_dev_mode()?;
    let input_path = args.input_path.as_ref().expect("validated input path");
    let output_dir = args
        .output_dir
        .as_ref()
        .expect("validated output directory");
    fs::create_dir_all(output_dir).context("create output directory")?;

    let input_bytes = fs::read(input_path).context("read prover input")?;
    let request: ProofRequest =
        serde_json::from_slice(&input_bytes).context("parse prover input")?;
    let proved = prove_request(&request);
    let journal = Journal::new(proved.journal.clone());

    let client = Client::builder()
        .with_rpc_url(required_url(args.rpc_url)?)
        .with_deployment(args.deployment)
        .with_uploader_config(&args.storage_config)
        .await?
        .config_storage_layer(|config| config.inline_input_max_bytes(MAX_INLINE_INPUT_BYTES))
        .with_private_key(required_private_key(args.private_key)?)
        .build()
        .await
        .context("failed to build Boundless client")?;

    let fulfillment = if let Some(request_id) = existing_request_id()? {
        tracing::info!("Fetching fulfilled Boundless request {:x}", request_id);
        client
            .boundless_market
            .get_request_fulfillment(request_id, None, None)
            .await
            .context("fetch Boundless proof fulfillment")?
    } else {
        let env = GuestEnv::builder()
            .write(&request)
            .context("encode zkVM input for Boundless")?;
        let proof_request = match args.program_url {
            Some(program_url) => client
                .new_request()
                .with_program_url(program_url)?
                .with_env(env)
                .with_image_id(image_id_digest())
                .with_cycles(batch_match_cycles()?)
                .with_journal(journal)
                .with_offer(default_offer())
                .with_groth16_proof(),
            None => client
                .new_request()
                .with_program(pnlx_risc0_methods::BATCH_MATCH_ELF)
                .with_env(env)
                .with_image_id(image_id_digest())
                .with_cycles(batch_match_cycles()?)
                .with_journal(journal)
                .with_offer(default_offer())
                .with_groth16_proof(),
        };

        let (request_id, expires_at) = client.submit(proof_request).await?;
        write_request_metadata(output_dir, request_id, expires_at)?;
        tracing::info!("Boundless batch-match request {:x} submitted", request_id);
        client
            .wait_for_request_fulfillment(request_id, POLL_INTERVAL, expires_at)
            .await
            .context("wait for Boundless proof fulfillment")?
    };
    let fulfillment_data = fulfillment.data().context("decode Boundless fulfillment")?;
    let image_id = fulfillment_data
        .image_id()
        .ok_or_else(|| anyhow!("missing Boundless image id"))?;
    let journal_bytes = fulfillment_data
        .journal()
        .ok_or_else(|| anyhow!("missing Boundless journal"))?
        .to_vec();

    if journal_bytes != proved.journal {
        anyhow::bail!("Boundless journal does not match expected batch public input bytes");
    }
    if Digest::from(<[u8; 32]>::from(image_id)) != image_id_digest() {
        anyhow::bail!("Boundless image id does not match PNLX batch-match guest");
    }

    let seal = fulfillment.seal.to_vec();
    validate_groth16_seal(&seal)?;
    let journal_path = output_dir.join("journal.bin");
    let seal_path = output_dir.join("seal.bin");
    let metadata_path = output_dir.join("proof.json");
    fs::write(&journal_path, &journal_bytes).context("write journal")?;
    fs::write(&seal_path, &seal).context("write seal")?;

    let output = ProofOutput {
        image_id: format!("0x{}", hex::encode(<[u8; 32]>::from(image_id))),
        journal_digest: format!("0x{}", hex::encode(Sha256::digest(&journal_bytes))),
        journal_path: journal_path.display().to_string(),
        seal_digest: format!("0x{}", hex::encode(Sha256::digest(&seal))),
        seal_path: seal_path.display().to_string(),
    };
    fs::write(&metadata_path, serde_json::to_vec_pretty(&output)?)
        .context("write proof metadata")?;
    println!("{}", metadata_path.display());
    Ok(())
}

fn validate_groth16_seal(seal: &[u8]) -> Result<()> {
    if seal.len() != GROTH16_SEAL_BYTES {
        anyhow::bail!(
            "Boundless returned a malformed Groth16 seal: expected {} bytes, received {}",
            GROTH16_SEAL_BYTES,
            seal.len()
        );
    }
    if seal.iter().all(|byte| *byte == 0) {
        anyhow::bail!("Boundless returned an all-zero Groth16 seal");
    }
    Ok(())
}

fn required_url(value: Option<Url>) -> Result<Url> {
    value
        .or_else(|| {
            env::var("RPC_URL")
                .ok()
                .and_then(|raw| Url::parse(&raw).ok())
        })
        .ok_or_else(|| anyhow!("BOUNDLESS_RPC_URL or RPC_URL is required for Boundless proving"))
}

fn required_private_key(value: Option<PrivateKeySigner>) -> Result<PrivateKeySigner> {
    if let Some(value) = value {
        return Ok(value);
    }
    env::var("PRIVATE_KEY")
        .context("BOUNDLESS_PRIVATE_KEY or PRIVATE_KEY is required for Boundless proving")?
        .parse()
        .context("parse Boundless private key")
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
        anyhow::bail!("RISC0_DEV_MODE must be disabled for Boundless Groth16 batch-match proving");
    }
    Ok(())
}

fn existing_request_id() -> Result<Option<U256>> {
    env::var("BOUNDLESS_REQUEST_ID")
        .ok()
        .map(|raw| parse_u256(&raw).context("parse BOUNDLESS_REQUEST_ID"))
        .transpose()
}

fn write_request_metadata(output_dir: &PathBuf, request_id: U256, expires_at: u64) -> Result<()> {
    let output = RequestOutput {
        expires_at,
        request_id: format!("0x{request_id:x}"),
    };
    fs::write(
        output_dir.join("request.json"),
        serde_json::to_vec_pretty(&output)?,
    )
    .context("write Boundless request metadata")
}

fn default_offer() -> OfferParams {
    OfferParams::builder()
        .min_price(Amount::new(
            env_u256("BOUNDLESS_MIN_PRICE_WEI", DEFAULT_MIN_PRICE_WEI),
            Asset::ETH,
        ))
        .max_price(Amount::new(
            env_u256("BOUNDLESS_MAX_PRICE_WEI", DEFAULT_MAX_PRICE_WEI),
            Asset::ETH,
        ))
        .lock_collateral(Amount::new(
            env_u256(
                "BOUNDLESS_LOCK_COLLATERAL_ZKC_WEI",
                DEFAULT_LOCK_COLLATERAL_ZKC_WEI,
            ),
            Asset::ZKC,
        ))
        .ramp_up_period(85)
        .lock_timeout(625)
        .timeout(1500)
        .into()
}

fn env_u256(name: &str, default: u64) -> U256 {
    env::var(name)
        .ok()
        .and_then(|raw| parse_u256(&raw).ok())
        .unwrap_or_else(|| U256::from(default))
}

fn parse_u256(raw: &str) -> Result<U256> {
    let trimmed = raw.trim();
    if let Some(hex) = trimmed.strip_prefix("0x") {
        return U256::from_str_radix(hex, 16).context("parse hex U256");
    }
    U256::from_str(trimmed).context("parse decimal U256")
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

fn image_id_digest() -> Digest {
    Digest::from(image_id_bytes())
}

fn image_id_bytes() -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, word) in pnlx_risc0_methods::BATCH_MATCH_ID.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}
