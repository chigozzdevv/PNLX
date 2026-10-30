use pnlx_risc0_batch_match_core::{prove_request, ProofRequest};

#[test]
fn proves_typescript_partial_fill_and_residual_margin_fixture() {
    let request: ProofRequest = serde_json::from_str(include_str!("fixtures/partial-match.json"))
        .expect("valid partial-fill proof request");
    let proved = prove_request(&request);
    assert_eq!(proved.draft.residual_margins, ["100000000", "0"]);
    assert_ne!(proved.draft.residual_commitments[0], "0x0");
    assert_eq!(
        proved.journal_digest,
        "0x79b75c384bf1b1aa737898465907b23c442cd5850b8e3a8de4a78b52d519f898"
    );
}
