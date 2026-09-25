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
        "0x197e5489ed23851445e3fcc24d3de7de8dc0ed2ffaa46682db8443535f62fa85"
    );
}
