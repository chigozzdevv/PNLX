#![no_std]

use governance_interface::GovernanceClient;
use intent_registry_interface::IntentRegistryClient;
use market_interface::{MarketClient, MarketPrice};
use position_state_interface::PositionStateClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, Bytes, BytesN, Env, Vec,
    U256,
};

const MAX_PUBLIC_ITEMS: u32 = 8;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Batch(BytesN<32>, BytesN<32>),
    Root(BytesN<32>),
    Governance,
    ProofLedger,
    MarketContract,
    PositionState,
    IntentRegistry,
    Circuit,
}

#[derive(Clone)]
#[contracttype]
pub struct ProofMeta {
    pub circuit_id: BytesN<32>,
    pub circuit_hash: BytesN<32>,
    pub verifier_hash: BytesN<32>,
    pub public_input_hash: BytesN<32>,
    pub proof_digest: BytesN<32>,
}

#[derive(Clone)]
#[contracttype]
pub struct SettlementMeta {
    pub old_root: BytesN<32>,
    pub new_root: BytesN<32>,
    pub proof: ProofMeta,
    pub oracle_price: i128,
    pub oracle_timestamp: u64,
    pub volume: i128,
    pub residual: i128,
}

#[contract]
pub struct BatchSettlement;

#[contractimpl]
impl BatchSettlement {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        market_contract: Address,
        position_state: Address,
        intent_registry: Address,
        circuit_id: BytesN<32>,
    ) {
        validate_hash(&env, &circuit_id);
        if env.storage().persistent().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Governance, &governance);
        env.storage()
            .persistent()
            .set(&DataKey::ProofLedger, &proof_ledger);
        env.storage()
            .persistent()
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .persistent()
            .set(&DataKey::PositionState, &position_state);
        env.storage()
            .persistent()
            .set(&DataKey::IntentRegistry, &intent_registry);
        env.storage()
            .persistent()
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn settle(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
        old_root: BytesN<32>,
        new_root: BytesN<32>,
        settlement_digest: BytesN<32>,
        proof: ProofMeta,
        filled_intents: Vec<BytesN<32>>,
        new_commitments: Vec<BytesN<32>>,
        margin_change_commitments: Vec<BytesN<32>>,
        spent_nullifiers: Vec<BytesN<32>>,
        volume: i128,
        residual: i128,
    ) {
        if volume <= 0 {
            panic!("invalid volume");
        }
        if residual < 0 {
            panic!("invalid residual");
        }
        validate_public_items(&env, &new_commitments, true);
        validate_public_items(&env, &margin_change_commitments, false);
        validate_public_items(&env, &spent_nullifiers, true);
        validate_proof(&env, &proof);
        validate_public_inputs(
            &env,
            &batch_id,
            &market_id,
            &old_root,
            &new_root,
            &settlement_digest,
            &filled_intents,
            &new_commitments,
            &margin_change_commitments,
            &spent_nullifiers,
            residual,
            volume,
            &proof,
        );
        validate_active_intents(&env, &filled_intents);

        let batch_key = DataKey::Batch(batch_id, market_id.clone());
        if env.storage().persistent().has(&batch_key) {
            panic!("batch settled");
        }
        let oracle = checked_market_price(&env, &market_id);
        advance_position_root(&env, &old_root, &new_root);

        let meta = SettlementMeta {
            old_root,
            new_root: new_root.clone(),
            proof,
            oracle_price: oracle.price,
            oracle_timestamp: oracle.timestamp,
            volume,
            residual,
        };
        env.storage().persistent().set(&batch_key, &meta);
        env.storage()
            .persistent()
            .set(&DataKey::Root(new_root), &true);
    }

    pub fn has_root(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Root(root))
    }

    pub fn is_settled(env: Env, batch_id: BytesN<32>, market_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Batch(batch_id, market_id))
    }
}

fn validate_active_intents(env: &Env, filled_intents: &Vec<BytesN<32>>) {
    validate_public_items(env, filled_intents, true);

    let registry_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::IntentRegistry)
        .unwrap_or_else(|| panic!("not initialized"));
    let registry = IntentRegistryClient::new(env, &registry_id);
    let mut seen = Vec::<BytesN<32>>::new(env);

    for intent in filled_intents.iter() {
        if seen.contains(&intent) {
            panic!("duplicate intent");
        }
        if !registry.is_active_intent(&intent) {
            panic!("inactive intent");
        }
        seen.push_back(intent);
    }
}

fn validate_public_items(env: &Env, values: &Vec<BytesN<32>>, require_non_empty: bool) {
    if require_non_empty && values.is_empty() {
        panic!("missing public items");
    }
    if values.len() > MAX_PUBLIC_ITEMS {
        panic!("too many public items");
    }

    for value in values.iter() {
        validate_hash(env, &value);
    }
}

fn advance_position_root(env: &Env, old_root: &BytesN<32>, new_root: &BytesN<32>) {
    let position_state_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::PositionState)
        .unwrap_or_else(|| panic!("not initialized"));
    PositionStateClient::new(env, &position_state_id).advance_root(
        &env.current_contract_address(),
        old_root,
        new_root,
    );
}

fn validate_proof(env: &Env, proof: &ProofMeta) {
    validate_hash(env, &proof.circuit_id);
    validate_hash(env, &proof.circuit_hash);
    validate_hash(env, &proof.verifier_hash);
    validate_hash(env, &proof.public_input_hash);
    validate_hash(env, &proof.proof_digest);

    let circuit_id: BytesN<32> = env
        .storage()
        .persistent()
        .get(&DataKey::Circuit)
        .unwrap_or_else(|| panic!("not initialized"));
    if proof.circuit_id != circuit_id {
        panic!("circuit mismatch");
    }

    let governance_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Governance)
        .unwrap_or_else(|| panic!("not initialized"));
    let governance = GovernanceClient::new(env, &governance_id);
    if governance.paused() {
        panic!("paused");
    }

    let expected = governance.verifier(&circuit_id);
    if proof.verifier_hash != expected {
        panic!("verifier mismatch");
    }

    let proof_ledger_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ProofLedger)
        .unwrap_or_else(|| panic!("not initialized"));
    let proof_ledger = ProofLedgerClient::new(env, &proof_ledger_id);
    if !proof_ledger.has_proof(
        &proof.circuit_id,
        &proof.verifier_hash,
        &proof.public_input_hash,
        &proof.proof_digest,
    ) {
        panic!("unverified proof");
    }
}

fn checked_market_price(env: &Env, market_id: &BytesN<32>) -> MarketPrice {
    let market_id_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::MarketContract)
        .unwrap_or_else(|| panic!("not initialized"));
    let market = MarketClient::new(env, &market_id_contract);
    if !market.is_active(market_id) {
        panic!("inactive market");
    }
    let price = market.mark_price(market_id);
    if price.price <= 0 {
        panic!("invalid oracle price");
    }
    price
}

fn validate_public_inputs(
    env: &Env,
    batch_id: &BytesN<32>,
    market_id: &BytesN<32>,
    old_root: &BytesN<32>,
    new_root: &BytesN<32>,
    settlement_digest: &BytesN<32>,
    filled_intents: &Vec<BytesN<32>>,
    new_commitments: &Vec<BytesN<32>>,
    margin_change_commitments: &Vec<BytesN<32>>,
    spent_nullifiers: &Vec<BytesN<32>>,
    residual: i128,
    volume: i128,
    proof: &ProofMeta,
) {
    let expected = batch_public_input_hash(
        env,
        batch_id,
        market_id,
        old_root,
        new_root,
        settlement_digest,
        filled_intents,
        new_commitments,
        margin_change_commitments,
        spent_nullifiers,
        residual as u128,
        volume as u128,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn batch_public_input_hash(
    env: &Env,
    batch_id: &BytesN<32>,
    market_id: &BytesN<32>,
    old_root: &BytesN<32>,
    new_root: &BytesN<32>,
    settlement_digest: &BytesN<32>,
    filled_intents: &Vec<BytesN<32>>,
    new_commitments: &Vec<BytesN<32>>,
    margin_change_commitments: &Vec<BytesN<32>>,
    spent_nullifiers: &Vec<BytesN<32>>,
    residual: u128,
    volume: u128,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_field(&mut public_inputs, batch_id);
    append_field(&mut public_inputs, market_id);
    append_field(&mut public_inputs, old_root);
    append_field(&mut public_inputs, new_root);
    append_field(&mut public_inputs, settlement_digest);
    append_public_vec(env, &mut public_inputs, filled_intents);
    append_public_vec(env, &mut public_inputs, new_commitments);
    append_public_vec(env, &mut public_inputs, margin_change_commitments);
    append_public_vec(env, &mut public_inputs, spent_nullifiers);
    append_u128_field(env, &mut public_inputs, residual);
    append_u128_field(env, &mut public_inputs, volume);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn append_public_vec(env: &Env, out: &mut Bytes, values: &Vec<BytesN<32>>) {
    append_u128_field(env, out, values.len() as u128);
    let zero = BytesN::from_array(env, &[0; 32]);
    let mut index = 0u32;
    while index < MAX_PUBLIC_ITEMS {
        if index < values.len() {
            append_field(out, &values.get(index).unwrap());
        } else {
            append_field(out, &zero);
        }
        index += 1;
    }
}

fn append_u128_field(env: &Env, out: &mut Bytes, value: u128) {
    let encoded = U256::from_u128(env, value).to_be_bytes();
    out.append(&encoded);
}

fn append_field(out: &mut Bytes, value: &BytesN<32>) {
    out.extend_from_slice(&Bn254Fr::from_bytes(value.clone()).to_bytes().to_array());
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid proof");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{BatchSettlement, BatchSettlementClient, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use intent_registry::{IntentRegistry, IntentRegistryClient};
    use market::{Market, MarketClient};
    use test_oracle::{TestOracle, TestOracleClient};
    use oracle_interface::OracleAsset;
    use position_state::{PositionState, PositionStateClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol, Vec,
    };

    #[test]
    fn settles_batch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
        assert!(client.is_settled(&batch, &market));
        assert!(client.has_root(&new_root));
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_settlement_argument_mismatch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &3,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "batch settled")]
    fn rejects_duplicate_batch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_proof() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = empty_proof(&env);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance_with_verifier(&env, &BytesN::from_array(&env, &[10; 32])),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "circuit mismatch")]
    fn rejects_wrong_circuit() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &BytesN::from_array(&env, &[11; 32]),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_protocol() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        let governance = setup_governance(&env);
        let proof_ledger = setup_proof_ledger(&env, Some(&proof));
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        client.init(
            &governance,
            &proof_ledger,
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "stale oracle price")]
    fn rejects_stale_market_oracle() {
        let env = Env::default();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        let market_contract = setup_market(&env, &market, 50_000_00000000, 950, true);
        set_market_oracle_price(&env, &market_contract, &market, 50_000_00000000, 700);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &market_contract,
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "inactive market")]
    fn rejects_inactive_market() {
        let env = Env::default();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, false),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "inactive intent")]
    fn rejects_cancelled_intent() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, true),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    #[test]
    #[should_panic(expected = "duplicate intent")]
    fn rejects_duplicate_filled_intent() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let old_root = BytesN::from_array(&env, &[3; 32]);
        let new_root = BytesN::from_array(&env, &[4; 32]);
        let duplicate_intents = duplicate_filled_intents(&env);
        let proof = proof_with_intents(&env, &duplicate_intents);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id, &old_root),
            &setup_intent_registry(&env, false),
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &old_root,
            &new_root,
            &settlement_digest(&env),
            &proof,
            &duplicate_intents,
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &2,
            &0,
        );
    }

    fn proof(env: &Env) -> ProofMeta {
        proof_with_intents(env, &filled_intents(env))
    }

    fn proof_with_intents(env: &Env, filled_intents: &Vec<BytesN<32>>) -> ProofMeta {
        let batch = BytesN::from_array(env, &[1; 32]);
        let market = BytesN::from_array(env, &[2; 32]);
        let old_root = BytesN::from_array(env, &[3; 32]);
        let new_root = BytesN::from_array(env, &[4; 32]);
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[6; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::batch_public_input_hash(
                env,
                &batch,
                &market,
                &old_root,
                &new_root,
                &settlement_digest(env),
                filled_intents,
                &new_commitments(env),
                &margin_change_commitments(env),
                &spent_nullifiers(env),
                0,
                2,
            ),
            proof_digest: BytesN::from_array(env, &[9; 32]),
        }
    }

    fn settlement_digest(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[10; 32])
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7; 32])
    }

    fn filled_intents(env: &Env) -> Vec<BytesN<32>> {
        let mut intents = Vec::new(env);
        intents.push_back(intent_a(env));
        intents.push_back(intent_b(env));
        intents
    }

    fn duplicate_filled_intents(env: &Env) -> Vec<BytesN<32>> {
        let mut intents = Vec::new(env);
        intents.push_back(intent_a(env));
        intents.push_back(intent_a(env));
        intents
    }

    fn new_commitments(env: &Env) -> Vec<BytesN<32>> {
        let mut commitments = Vec::new(env);
        commitments.push_back(BytesN::from_array(env, &[13; 32]));
        commitments.push_back(BytesN::from_array(env, &[14; 32]));
        commitments
    }

    fn margin_change_commitments(env: &Env) -> Vec<BytesN<32>> {
        Vec::new(env)
    }

    fn spent_nullifiers(env: &Env) -> Vec<BytesN<32>> {
        let mut nullifiers = Vec::new(env);
        nullifiers.push_back(BytesN::from_array(env, &[15; 32]));
        nullifiers.push_back(BytesN::from_array(env, &[16; 32]));
        nullifiers
    }

    fn intent_a(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[11; 32])
    }

    fn intent_b(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[12; 32])
    }

    fn setup_governance(env: &Env) -> Address {
        setup_governance_with_verifier(env, &verifier(env))
    }

    fn setup_position_state(env: &Env, writer: &Address, initial_root: &BytesN<32>) -> Address {
        env.mock_all_auths();
        let state_id = env.register(PositionState, ());
        let state = PositionStateClient::new(env, &state_id);
        state.init(&setup_governance(env), initial_root);
        state.set_writer(writer, &true);
        state_id
    }

    fn setup_intent_registry(env: &Env, cancel_first: bool) -> Address {
        let registry_id = env.register(IntentRegistry, ());
        let registry = IntentRegistryClient::new(env, &registry_id);
        let batch = BytesN::from_array(env, &[1; 32]);
        let market = BytesN::from_array(env, &[2; 32]);
        let shares_a = BytesN::from_array(env, &[21; 32]);
        let shares_b = BytesN::from_array(env, &[22; 32]);

        registry.submit(&batch, &market, &intent_a(env), &shares_a);
        registry.submit(&batch, &market, &intent_b(env), &shares_b);
        if cancel_first {
            registry.cancel(&intent_a(env));
        }
        registry_id
    }

    fn setup_governance_with_verifier(env: &Env, verifier_hash: &BytesN<32>) -> Address {
        env.mock_all_auths();
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);
        let authority = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&circuit(env), verifier_hash, &authority);
        governance_id
    }

    fn setup_proof_ledger(env: &Env, proof: Option<&ProofMeta>) -> Address {
        env.mock_all_auths();
        let authority = Address::generate(env);
        let governance = match proof {
            Some(proof) => setup_governance_with_authority(env, &proof.verifier_hash, &authority),
            None => setup_governance_with_authority(env, &verifier(env), &authority),
        };
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(env, &ledger_id);

        ledger.init(&governance);
        if let Some(proof) = proof {
            ledger.record(
                &authority,
                &proof.circuit_id,
                &proof.verifier_hash,
                &proof.public_input_hash,
                &proof.proof_digest,
            );
        }
        ledger_id
    }

    fn setup_market(
        env: &Env,
        market_id: &BytesN<32>,
        price: i128,
        timestamp: u64,
        active: bool,
    ) -> Address {
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle_id = env.register(TestOracle, ());
        let oracle = TestOracleClient::new(env, &oracle_id);
        oracle.init(&8);
        oracle.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &price,
            &timestamp,
        );

        let market_contract = env.register(Market, ());
        let market = MarketClient::new(env, &market_contract);
        market.init(&setup_governance(env));
        market.upsert_other(
            market_id,
            &oracle_id,
            &symbol_short!("sep40"),
            &Symbol::new(env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &active,
        );
        market_contract
    }

    fn set_market_oracle_price(
        env: &Env,
        market_contract: &Address,
        market_id: &BytesN<32>,
        price: i128,
        timestamp: u64,
    ) {
        let market = MarketClient::new(env, market_contract);
        let config = market.get(market_id);
        let oracle = TestOracleClient::new(env, &config.oracle_contract);
        oracle.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &price,
            &timestamp,
        );
    }

    fn setup_governance_with_authority(
        env: &Env,
        verifier_hash: &BytesN<32>,
        authority: &Address,
    ) -> Address {
        env.mock_all_auths();
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&circuit(env), verifier_hash, authority);
        governance_id
    }

    fn empty_proof(env: &Env) -> ProofMeta {
        ProofMeta {
            circuit_id: BytesN::from_array(env, &[0; 32]),
            circuit_hash: BytesN::from_array(env, &[0; 32]),
            verifier_hash: BytesN::from_array(env, &[0; 32]),
            public_input_hash: BytesN::from_array(env, &[0; 32]),
            proof_digest: BytesN::from_array(env, &[0; 32]),
        }
    }
}
