extern crate std;

use super::*;
use governance::{Governance, GovernanceClient as RealGovernanceClient};
use market::{Market, MarketClient as RealMarketClient};
use oracle_interface::OracleAsset;
use position_state::{PositionState, PositionStateClient as RealStateClient};
use proof_ledger::{ProofLedger, ProofLedgerClient as RealLedgerClient};
use shielded_pool::{ShieldedPool, ShieldedPoolClient as RealPoolClient};
use soroban_sdk::{testutils::{Address as _, Events, Ledger}, Symbol};
use test_oracle::{TestOracle, TestOracleClient};

fn value(env: &Env, number: u8) -> BytesN<32> {
    let mut bytes = [0; 32]; bytes[31] = number; BytesN::from_array(env, &bytes)
}

struct Fixture {
    env: Env, governance: Address, ledger: Address, state: Address, pool: Address,
    market: Address, oracle: Address, helper: Address, authority: Address, pairs: Vec<AllowedPair>,
    root: BytesN<32>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().with_mut(|ledger| { ledger.timestamp = 1_000; ledger.sequence_number = 42; });
        let governance = env.register(Governance, ());
        let admin = Address::generate(&env);
        let gov = RealGovernanceClient::new(&env, &governance);
        gov.init(&admin);
        let ledger = env.register(ProofLedger, ());
        RealLedgerClient::new(&env, &ledger).init(&governance);
        let authority = Address::generate(&env);
        gov.set_verifier(&value(&env, 80), &value(&env, 81), &authority);
        let oracle = env.register(TestOracle, ());
        let oracle_client = TestOracleClient::new(&env, &oracle);
        oracle_client.init(&8);
        oracle_client.set_price(&OracleAsset::Other(Symbol::new(&env, "BTC")), &150, &1_000);
        let market = env.register(Market, ());
        let market_client = RealMarketClient::new(&env, &market);
        market_client.init(&governance);
        market_client.upsert_other(&value(&env, 90), &oracle, &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"), &120, &1, &8, &5, &200_000, &100_000, &-3, &true);
        let state = env.register(PositionState, ());
        let state_client = RealStateClient::new(&env, &state);
        state_client.init(&governance);
        state_client.set_writer(&admin, &true);
        let pool = env.register(ShieldedPool, ());
        let pool_client = RealPoolClient::new(&env, &pool);
        pool_client.init(&governance, &ledger, &value(&env, 82), &value(&env, 83));
        pool_client.configure_secure_note_circuits(&value(&env, 84), &value(&env, 85));
        pool_client.disable_legacy_notes();
        pool_client.set_writer(&admin, &true);
        let mut pairs = Vec::new(&env);
        let mut leaves = Vec::new(&env);
        for pair in 0..3u8 {
            let commitments = Vec::from_array(&env, [value(&env, 1 + pair * 2), value(&env, 2 + pair * 2)]);
            for commitment in commitments.iter() { leaves.push_back(commitment); }
            pairs.push_back(AllowedPair { market_id: value(&env, 90), asset_digest: value(&env, 91),
                position_commitments: commitments,
                position_nullifiers: Vec::from_array(&env, [value(&env, 11 + pair * 2), value(&env, 12 + pair * 2)]) });
        }
        let root = state_client.append_many(&admin, &leaves).root;
        let helper = env.register(LegacyPairExit, (governance.clone(), ledger.clone(), market.clone(),
            state.clone(), pool.clone(), value(&env, 80), pairs.clone()));
        state_client.set_writer(&helper, &true);
        pool_client.set_writer(&helper, &true);
        Self { env, governance, ledger, state, pool, market, oracle, helper, authority, pairs, root }
    }

    fn args(&self, index: u32) -> PairCloseArgs {
        let pair = self.pairs.get_unchecked(index);
        let offset = (index * 2) as u8;
        PairCloseArgs { market_id: pair.market_id, mark_price: 150, liquidation: true,
            position_root: self.root.clone(), position_commitments: pair.position_commitments,
            position_nullifiers: pair.position_nullifiers,
            close_commitments: Vec::from_array(&self.env, [value(&self.env, 20 + offset), value(&self.env, 21 + offset)]),
            new_position_commitments: Vec::from_array(&self.env, [value(&self.env, 30 + offset), value(&self.env, 31 + offset)]),
            margin_output_commitments: Vec::from_array(&self.env, [value(&self.env, 40 + offset), value(&self.env, 41 + offset)]) }
    }

    fn proof(&self, args: &PairCloseArgs) -> ProofMeta {
        ProofMeta { circuit_id: value(&self.env, 80), circuit_hash: value(&self.env, 86),
            verifier_hash: value(&self.env, 81), proof_digest: value(&self.env, 87),
            public_input_hash: pair_public_input_hash(&self.env, args, &value(&self.env, 91), 3, true, 100_000) }
    }

    fn record(&self, proof: &ProofMeta) {
        RealLedgerClient::new(&self.env, &self.ledger).record(&self.authority, &proof.circuit_id,
            &proof.verifier_hash, &proof.public_input_hash, &proof.proof_digest);
    }

    fn pause(&self) { RealGovernanceClient::new(&self.env, &self.governance).set_paused(&true); }

    fn assert_unmodified(&self) {
        let state = RealStateClient::new(&self.env, &self.state);
        assert_eq!(state.current_root(), self.root);
        assert_eq!(state.leaf_count(), 6);
        assert!(!state.is_spent(&value(&self.env, 11)));
        assert_eq!(RealPoolClient::new(&self.env, &self.pool).secure_note_count(), 0);
        assert_eq!(LegacyPairExitClient::new(&self.env, &self.helper).completed_pairs(), 0);
    }
}

#[test]
fn exits_one_pair_with_default_budget_and_exact_immutable_receipts() {
    let fixture = Fixture::new();
    let args = fixture.args(0);
    let proof = fixture.proof(&args);
    fixture.record(&proof); fixture.pause();
    fixture.env.cost_estimate().budget().reset_default();
    let client = LegacyPairExitClient::new(&fixture.env, &fixture.helper);
    let appended = client.exit_pair(&args, &proof);
    let cpu = fixture.env.cost_estimate().budget().cpu_instruction_cost();
    let events = fixture.env.events().all().filter_by_contract(&fixture.helper);
    std::println!("legacy pair default-budget CPU: {cpu}");
    fixture.env.cost_estimate().budget().reset_unlimited();
    let state = RealStateClient::new(&fixture.env, &fixture.state);
    assert_eq!(appended.count, 2); assert_eq!(appended.first_index, 6);
    assert_eq!(appended.root, state.current_root());
    assert_eq!(state.leaf_count(), 8);
    assert_eq!(client.allowed_pairs(), fixture.pairs);
    let receipt = client.receipt(&args.position_commitments.get_unchecked(0)).unwrap();
    assert_eq!(receipt.appended, appended);
    assert_eq!(receipt.position_commitments, args.position_commitments);
    assert_eq!(receipt.margin_output_commitments, args.margin_output_commitments);
    assert_eq!(receipt.proof_digest, proof.proof_digest);
    for i in 0..2 {
        assert!(state.is_spent(&args.position_nullifiers.get_unchecked(i)));
        assert!(state.is_commitment_spent(&args.position_commitments.get_unchecked(i)));
        assert!(RealPoolClient::new(&fixture.env, &fixture.pool).has_commitment(&args.margin_output_commitments.get_unchecked(i)));
        let close = args.close_commitments.get_unchecked(i);
        assert_eq!(client.closed_ledger(&close), 42);
        assert_eq!(client.output_position_index(&close), 6 + i);
        assert_eq!(client.receipt_by_close(&close), Some(receipt.clone()));
        let close_receipt = client.close_receipt(&close).unwrap();
        assert_eq!(close_receipt.position_commitment, args.position_commitments.get_unchecked(i));
        assert_eq!(close_receipt.margin_output_commitment, args.margin_output_commitments.get_unchecked(i));
    }
    assert_eq!(client.completed_pairs(), 1);
    let mut expected_events = Vec::<(Address,Vec<Val>,Val)>::new(&fixture.env);
    for i in 0..2 {
        expected_events.push_back((fixture.helper.clone(),Vec::from_array(&fixture.env,[
            symbol_short!("pairclose").into_val(&fixture.env),args.close_commitments.get_unchecked(i).into_val(&fixture.env),
        ]),args.position_nullifiers.get_unchecked(i).into_val(&fixture.env)));
    }
    assert_eq!(events,expected_events);
    assert!(client.try_exit_pair(&args, &proof).is_err());
    assert_eq!(state.leaf_count(), 8);
}

#[test]
fn public_hash_matches_the_eighteen_field_big_endian_abi() {
    let fixture = Fixture::new();
    let mut args = fixture.args(0);
    args.market_id = BytesN::from_array(&fixture.env,&[255;32]);
    args.position_root = value(&fixture.env,100);
    let digest = pair_public_input_hash(&fixture.env,&args,&value(&fixture.env,91),3,true,100_000);
    assert_eq!(digest,BytesN::from_array(&fixture.env,&[
        0x93,0x57,0x37,0x7b,0x03,0x64,0x03,0xac,0x83,0xa8,0x01,0x2d,0xe6,0xbd,0x0c,0x7a,
        0x98,0x33,0x65,0x80,0x9e,0x3d,0x6b,0x34,0xe4,0x64,0x4f,0x56,0x79,0x43,0x52,0x5f,
    ]));
}

#[test]
fn all_three_recorded_pairs_exit_once_using_the_original_historical_root() {
    let fixture = Fixture::new();
    let mut prepared = std::vec![];
    for index in 0..3 { let args = fixture.args(index); let proof = fixture.proof(&args); fixture.record(&proof); prepared.push((args, proof)); }
    fixture.pause();
    let client = LegacyPairExitClient::new(&fixture.env, &fixture.helper);
    for (index, (args, proof)) in prepared.iter().enumerate() {
        let appended = client.exit_pair(args, proof);
        assert_eq!(appended.first_index, 6 + index as u32 * 2);
        assert_eq!(client.completed_pairs(), index as u32 + 1);
    }
    assert_eq!(RealStateClient::new(&fixture.env, &fixture.state).leaf_count(), 12);
    assert_eq!(RealPoolClient::new(&fixture.env, &fixture.pool).secure_note_count(), 6);
}

#[test]
fn rejects_unsigned_admin_redemption_and_unpaused_protocol() {
    let fixture = Fixture::new(); let args = fixture.args(0); let proof = fixture.proof(&args);
    fixture.record(&proof);
    let client = LegacyPairExitClient::new(&fixture.env, &fixture.helper);
    assert!(client.try_exit_pair(&args, &proof).is_err());
    fixture.pause(); fixture.env.set_auths(&[]);
    assert!(client.try_exit_pair(&args, &proof).is_err());
    fixture.env.mock_all_auths(); fixture.assert_unmodified();
}

#[test]
fn rejects_unlisted_reordered_or_forged_nullifier_pairs() {
    for change in 0..3 {
        let fixture = Fixture::new(); let mut args = fixture.args(0);
        if change == 0 { args.position_commitments.set(0, value(&fixture.env, 99)); }
        if change == 1 { let first = args.position_commitments.get_unchecked(0); args.position_commitments.set(0,args.position_commitments.get_unchecked(1)); args.position_commitments.set(1,first); }
        if change == 2 { args.position_nullifiers.set(0, value(&fixture.env, 99)); }
        let proof = fixture.proof(&args); fixture.record(&proof); fixture.pause();
        assert!(LegacyPairExitClient::new(&fixture.env, &fixture.helper).try_exit_pair(&args, &proof).is_err());
        fixture.assert_unmodified();
    }
}

#[test]
fn rejects_missing_retired_wrong_circuit_and_changed_output_proofs() {
    for change in 0..4 {
        let fixture = Fixture::new(); let mut args = fixture.args(0); let mut proof = fixture.proof(&args);
        if change != 0 { fixture.record(&proof); }
        if change == 1 { proof.verifier_hash = value(&fixture.env, 99); }
        if change == 2 { proof.circuit_id = value(&fixture.env, 99); }
        if change == 3 { args.margin_output_commitments.set(0,value(&fixture.env, 99)); }
        fixture.pause();
        assert!(LegacyPairExitClient::new(&fixture.env, &fixture.helper).try_exit_pair(&args, &proof).is_err());
        fixture.assert_unmodified();
    }
}

#[test]
fn retired_legacy_verifier_cannot_reuse_a_previously_recorded_proof() {
    let fixture = Fixture::new(); let args = fixture.args(0); let proof = fixture.proof(&args);
    fixture.record(&proof);
    RealGovernanceClient::new(&fixture.env,&fixture.governance).set_verifier(
        &proof.circuit_id,&value(&fixture.env,99),&fixture.authority);
    fixture.pause();
    assert!(LegacyPairExitClient::new(&fixture.env,&fixture.helper).try_exit_pair(&args,&proof).is_err());
    fixture.assert_unmodified();
}

#[test]
fn field_alias_cannot_replace_a_proven_refund_with_a_different_raw_commitment() {
    let fixture = Fixture::new(); let mut args = fixture.args(0); let proof = fixture.proof(&args);
    fixture.record(&proof);
    let modulus = U256::from_be_bytes(&fixture.env,&Bytes::from_array(&fixture.env,&FIELD_MODULUS));
    let alias = modulus.add(&U256::from_u128(&fixture.env,40)).to_be_bytes();
    args.margin_output_commitments.set(0,BytesN::try_from(alias).unwrap());
    assert_eq!(fixture.proof(&args).public_input_hash,proof.public_input_hash);
    fixture.pause();
    assert!(LegacyPairExitClient::new(&fixture.env,&fixture.helper).try_exit_pair(&args,&proof).is_err());
    fixture.assert_unmodified();
}

#[test]
fn binds_actual_oracle_mark_signed_funding_maintenance_and_asset() {
    for change in 0..4 {
        let fixture = Fixture::new(); let args = fixture.args(0); let mut proof = fixture.proof(&args);
        if change == 0 { TestOracleClient::new(&fixture.env, &fixture.oracle).set_price(&OracleAsset::Other(Symbol::new(&fixture.env,"BTC")), &151, &1_000); }
        if change == 1 { proof.public_input_hash = pair_public_input_hash(&fixture.env,&args,&value(&fixture.env,91),3,false,100_000); }
        if change == 2 { proof.public_input_hash = pair_public_input_hash(&fixture.env,&args,&value(&fixture.env,91),3,true,99_999); }
        if change == 3 { proof.public_input_hash = pair_public_input_hash(&fixture.env,&args,&value(&fixture.env,92),3,true,100_000); }
        fixture.record(&proof); fixture.pause();
        assert!(LegacyPairExitClient::new(&fixture.env,&fixture.helper).try_exit_pair(&args,&proof).is_err());
        fixture.assert_unmodified();
    }
}

#[test]
fn rejects_stale_oracle_data_and_unknown_roots_before_any_mutation() {
    for stale in [false, true] {
        let fixture = Fixture::new(); let mut args = fixture.args(0);
        if stale { fixture.env.ledger().with_mut(|ledger|ledger.timestamp=1_121); }
        else { args.position_root = value(&fixture.env, 98); }
        let proof = fixture.proof(&args); fixture.record(&proof); fixture.pause();
        assert!(LegacyPairExitClient::new(&fixture.env,&fixture.helper).try_exit_pair(&args,&proof).is_err());
        fixture.assert_unmodified();
    }
}

#[test]
fn second_pool_append_failure_rolls_back_both_spends_and_all_position_appends() {
    let fixture = Fixture::new(); let args = fixture.args(0); let proof = fixture.proof(&args);
    fixture.record(&proof);
    let admin = RealGovernanceClient::new(&fixture.env,&fixture.governance).admin();
    let pool = RealPoolClient::new(&fixture.env,&fixture.pool);
    pool.append_secure_note(&admin,&args.margin_output_commitments.get_unchecked(1));
    let pool_root = pool.secure_note_root(); fixture.pause();
    let client = LegacyPairExitClient::new(&fixture.env,&fixture.helper);
    assert!(client.try_exit_pair(&args,&proof).is_err());
    let state = RealStateClient::new(&fixture.env,&fixture.state);
    assert_eq!(state.current_root(),fixture.root); assert_eq!(state.leaf_count(),6);
    for i in 0..2 { assert!(!state.is_spent(&args.position_nullifiers.get_unchecked(i))); assert!(!state.is_commitment_spent(&args.position_commitments.get_unchecked(i))); }
    assert!(!pool.has_commitment(&args.margin_output_commitments.get_unchecked(0)));
    assert_eq!(pool.secure_note_root(),pool_root); assert_eq!(pool.secure_note_count(),1);
    assert_eq!(client.completed_pairs(),0); assert!(!client.is_settled(&args.close_commitments.get_unchecked(0)));
    assert!(client.receipt(&args.position_commitments.get_unchecked(0)).is_none());
}

#[test]
fn revoked_writer_prevents_exit_and_cannot_partially_spend_a_pair() {
    let fixture = Fixture::new(); let args = fixture.args(0); let proof = fixture.proof(&args);
    fixture.record(&proof);
    RealPoolClient::new(&fixture.env,&fixture.pool).set_writer(&fixture.helper,&false);
    fixture.pause();
    assert!(LegacyPairExitClient::new(&fixture.env,&fixture.helper).try_exit_pair(&args,&proof).is_err());
    fixture.assert_unmodified();
}

#[test]
#[should_panic(expected = "exactly three legacy pairs required")]
fn constructor_rejects_a_generic_or_incomplete_allowlist() {
    let fixture = Fixture::new();
    fixture.env.register(LegacyPairExit,(fixture.governance,fixture.ledger,fixture.market,
        fixture.state,fixture.pool,value(&fixture.env,80),Vec::from_array(&fixture.env,[fixture.pairs.get_unchecked(0)])));
}

#[test]
#[should_panic(expected = "legacy positions overlap")]
fn constructor_rejects_overlapping_pairs() {
    let fixture = Fixture::new(); let mut pairs = fixture.pairs.clone();
    pairs.set(2,pairs.get_unchecked(0));
    fixture.env.register(LegacyPairExit,(fixture.governance,fixture.ledger,fixture.market,
        fixture.state,fixture.pool,value(&fixture.env,80),pairs));
}

#[test]
fn public_hash_matches_the_independently_verified_legacy_noir_receipt() {
    let env = Env::default();
    let field = |raw: &str| {
        let text = raw.strip_prefix("0x").unwrap_or(raw);
        assert_eq!(text.len(),64);
        let mut bytes = [0u8;32];
        for index in 0..32 { bytes[index] = u8::from_str_radix(&text[index*2..index*2+2],16).unwrap(); }
        BytesN::from_array(&env,&bytes)
    };
    let args = PairCloseArgs {
        market_id:field("0x305220576e790de6295591a198d6f58ef2a2248cd6616bd963b4a1112deed52a"), mark_price:150, liquidation:false,
        position_root:field("0x10e0bc3cad6a4313e2ce292aba98efdaaff15be57f2c6a83a45b519d5ebc088c"),
        position_commitments:Vec::from_array(&env,[field("0x068dc8cf598afb7817632c5fbb69a20966d5c8790428968b1492d028bc848be1"),field("0x1419046689cd49c851f06ad521478ec15b63119ada296db7e100c47edf83c6c9")]),
        position_nullifiers:Vec::from_array(&env,[field("0x25f106373d285972efcdfcbc99096a989156495514c4e1bc6cfac2b288ade5e7"),field("0x0b0d4e51189884a1d914c2fe0e822e1344b15119e5ef67b64f323c841611c813")]),
        close_commitments:Vec::from_array(&env,[field("0x0000000000000000000000000000000000000000000000000000000000000017"),field("0x0000000000000000000000000000000000000000000000000000000000000018")]),
        new_position_commitments:Vec::from_array(&env,[field("0x05a530b92e71fb2420954de0c2597fd5a3a8670f9b886bf9123a1a4f28fa66d2"),field("0x083945667353e8680105bef401c7e7afa0e6b2cc8a2c72d069178c895dc4c996")]),
        margin_output_commitments:Vec::from_array(&env,[field("0x0dcd31b61de66b04e2189a445eb4166f5b2d09c27b5976fedbf2cb2fb9e63b90"),field("0x2f8f4888f2aaa97b52f2f45c9f1d07a9cd6b9c0ce40a245aad910ec0240cd1fe")]),
    };
    assert_eq!(pair_public_input_hash(&env,&args,&field("0x0000000000000000000000000000000000000000000000000000000000000009"),2,false,100_000),
        field("0xa5a80d274e408c3bb6738f0b3251fb60f5eea3befe2810f6494eb0424d05500c"));
}
