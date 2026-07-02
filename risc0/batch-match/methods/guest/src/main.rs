use pnlx_risc0_batch_match_core::{prove_request, ProofRequest};
use risc0_zkvm::guest::env;

fn main() {
    let request: ProofRequest = env::read();
    let proved = prove_request(&request);
    env::commit_slice(&proved.journal);
}

