#![no_std]

use conditional_order_interface::ConditionalOrderClient;
use governance_interface::GovernanceClient;
use market_interface::MarketClient;
use position_state_interface::{AppendReceipt, PositionStateClient};
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
    U256,
};

const PRICE_SCALE: u128 = 100_000_000;
const BN254_SCALAR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Close(BytesN<32>),
    PositionSpent(BytesN<32>),
    ConditionalOrder,
    Governance,
    MarketContract,
    PositionState,
    ProofLedger,
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
pub struct PositionCloseMeta {
    pub market_id: BytesN<32>,
    pub mark_price: i128,
    pub position_commitment: BytesN<32>,
    pub position_nullifier: BytesN<32>,
    pub position_root: BytesN<32>,
    pub new_position_commitment: BytesN<32>,
    pub output_position_index: u32,
    pub output_position_root: BytesN<32>,
    pub margin_output_commitment: BytesN<32>,
    pub proof: ProofMeta,
}

#[contract]
pub struct PositionClose;

#[contractimpl]
impl PositionClose {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        conditional_order: Address,
        market_contract: Address,
        position_state: Address,
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
            .set(&DataKey::ConditionalOrder, &conditional_order);
        env.storage()
            .persistent()
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .persistent()
            .set(&DataKey::PositionState, &position_state);
        env.storage()
            .persistent()
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn settle(
        env: Env,
        market_id: BytesN<32>,
        position_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
        mark_price: i128,
        new_position_commitment: BytesN<32>,
        margin_output_commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        settle_position_close(
            env,
            market_id,
            position_root,
            position_commitment,
            position_nullifier,
            close_commitment,
            mark_price,
            new_position_commitment,
            margin_output_commitment,
            proof,
            true,
        );
    }

    pub fn settle_manual(
        env: Env,
        market_id: BytesN<32>,
        position_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
        mark_price: i128,
        new_position_commitment: BytesN<32>,
        margin_output_commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        settle_position_close(
            env,
            market_id,
            position_root,
            position_commitment,
            position_nullifier,
            close_commitment,
            mark_price,
            new_position_commitment,
            margin_output_commitment,
            proof,
            false,
        );
    }

    pub fn is_settled(env: Env, close_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Close(close_commitment))
    }

    pub fn is_position_spent(env: Env, position_nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::PositionSpent(position_nullifier))
    }
}

fn settle_position_close(
    env: Env,
    market_id: BytesN<32>,
    position_root: BytesN<32>,
    position_commitment: BytesN<32>,
    position_nullifier: BytesN<32>,
    close_commitment: BytesN<32>,
    mark_price: i128,
    new_position_commitment: BytesN<32>,
    margin_output_commitment: BytesN<32>,
    proof: ProofMeta,
    require_conditional_trigger: bool,
) {
    validate_hash(&env, &market_id);
    validate_hash(&env, &position_root);
    validate_hash(&env, &position_commitment);
    validate_hash(&env, &position_nullifier);
    validate_hash(&env, &close_commitment);
    validate_hash(&env, &new_position_commitment);
    validate_hash(&env, &margin_output_commitment);
    if mark_price <= 0 {
        panic!("invalid mark price");
    }
    validate_oracle_mark_price(&env, &market_id, mark_price);
    validate_proof(&env, &proof);
    validate_public_inputs(
        &env,
        mark_price,
        &position_root,
        &position_commitment,
        &position_nullifier,
        &close_commitment,
        &new_position_commitment,
        &margin_output_commitment,
        &proof,
    );
    if require_conditional_trigger {
        validate_conditional_trigger(&env, &market_id, &position_nullifier, &close_commitment);
    }

    let close_key = DataKey::Close(close_commitment.clone());
    if env.storage().persistent().has(&close_key) {
        panic!("close already settled");
    }
    let spent_key = DataKey::PositionSpent(position_nullifier.clone());
    if env.storage().persistent().has(&spent_key) {
        panic!("position already spent");
    }
    let appended = spend_and_append_position(
        &env,
        &position_root,
        &position_commitment,
        &position_nullifier,
        &new_position_commitment,
    );

    env.storage().persistent().set(
        &close_key,
        &PositionCloseMeta {
            market_id,
            mark_price,
            position_commitment,
            position_nullifier: position_nullifier.clone(),
            position_root,
            new_position_commitment,
            output_position_index: appended.first_index,
            output_position_root: appended.root,
            margin_output_commitment,
            proof,
        },
    );
    env.storage().persistent().set(&spent_key, &true);
}

fn spend_and_append_position(
    env: &Env,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    new_position_commitment: &BytesN<32>,
) -> AppendReceipt {
    let position_state_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::PositionState)
        .unwrap_or_else(|| panic!("not initialized"));
    let position_state = PositionStateClient::new(env, &position_state_id);
    let writer = env.current_contract_address();
    authorize_as_writer(
        env,
        position_state_id.clone(),
        "spend_position",
        Vec::from_array(
            env,
            [
                writer.clone().into_val(env),
                position_root.clone().into_val(env),
                position_commitment.clone().into_val(env),
                position_nullifier.clone().into_val(env),
            ],
        ),
    );
    position_state.spend_position(
        &writer,
        position_root,
        position_commitment,
        position_nullifier,
    );
    authorize_as_writer(
        env,
        position_state_id,
        "append",
        Vec::from_array(
            env,
            [
                writer.clone().into_val(env),
                new_position_commitment.clone().into_val(env),
            ],
        ),
    );
    position_state.append(&writer, new_position_commitment)
}

fn authorize_as_writer(env: &Env, contract: Address, fn_name: &str, args: Vec<Val>) {
    let invocation = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract,
            fn_name: Symbol::new(env, fn_name),
            args,
        },
        sub_invocations: Vec::new(env),
    });
    env.authorize_as_current_contract(Vec::from_array(env, [invocation]));
}

fn validate_oracle_mark_price(env: &Env, market_id: &BytesN<32>, mark_price: i128) {
    let market_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::MarketContract)
        .unwrap_or_else(|| panic!("not initialized"));
    let market = MarketClient::new(env, &market_contract);
    if !market.is_active(market_id) {
        panic!("inactive market");
    }
    let oracle = market.mark_price(market_id);
    if oracle.price != mark_price {
        panic!("mark price mismatch");
    }
}

fn validate_conditional_trigger(
    env: &Env,
    market_id: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    close_commitment: &BytesN<32>,
) {
    let conditional_order_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ConditionalOrder)
        .unwrap_or_else(|| panic!("not initialized"));
    let conditional_order = ConditionalOrderClient::new(env, &conditional_order_id);
    if !conditional_order.is_triggered_for(market_id, position_nullifier, close_commitment) {
        panic!("conditional close not triggered");
    }
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

fn validate_public_inputs(
    env: &Env,
    mark_price: i128,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    close_commitment: &BytesN<32>,
    new_position_commitment: &BytesN<32>,
    margin_output_commitment: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = position_close_public_input_hash(
        env,
        mark_price as u128,
        PRICE_SCALE,
        position_root,
        position_commitment,
        position_nullifier,
        close_commitment,
        new_position_commitment,
        margin_output_commitment,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn position_close_public_input_hash(
    env: &Env,
    mark_price: u128,
    price_scale: u128,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    close_commitment: &BytesN<32>,
    new_position_commitment: &BytesN<32>,
    margin_output_commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, mark_price);
    append_u128_field(env, &mut public_inputs, price_scale);
    append_field(env, &mut public_inputs, position_root);
    append_field(env, &mut public_inputs, position_commitment);
    append_field(env, &mut public_inputs, position_nullifier);
    append_field(env, &mut public_inputs, close_commitment);
    append_field(env, &mut public_inputs, new_position_commitment);
    append_field(env, &mut public_inputs, margin_output_commitment);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn append_u128_field(env: &Env, out: &mut Bytes, value: u128) {
    let encoded = U256::from_u128(env, value).to_be_bytes();
    out.append(&encoded);
}

fn append_field(env: &Env, out: &mut Bytes, value: &BytesN<32>) {
    out.append(&field_bytes(env, value));
}

fn field_bytes(env: &Env, value: &BytesN<32>) -> Bytes {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_SCALAR_MODULUS_BE));
    U256::from_be_bytes(env, &Bytes::from_array(env, &value.to_array()))
        .rem_euclid(&modulus)
        .to_be_bytes()
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid proof");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{PositionClose, PositionCloseClient, ProofMeta};
    use conditional_order::{
        ConditionalOrder, ConditionalOrderClient as ConditionalOrderRegistryClient,
        ProofMeta as ConditionalProofMeta,
    };
    use core::ops::{Add, Mul};
    use governance::{Governance, GovernanceClient};
    use market::{Market, MarketClient};
    use oracle_interface::OracleAsset;
    use position_state::{PositionState, PositionStateClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{
        crypto::bn254::Bn254Fr,
        symbol_short,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol, U256,
    };
    use test_oracle::{TestOracle, TestOracleClient};

    struct ProtocolSetup {
        conditional_authority: Address,
        governance: Address,
        market: Address,
        proof_ledger: Address,
        conditional_order: Address,
        position_state: Address,
        position_authority: Address,
    }

    #[test]
    fn records_position_close() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let new_position = BytesN::from_array(&env, &[4; 32]);
        let margin_output = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(&env);
        let conditional_proof = conditional_proof(&env);
        let setup = setup_protocol(&env, &id, Some(&proof), Some(&conditional_proof));

        trigger_conditional_order(
            &env,
            &setup.conditional_order,
            &market,
            &nullifier,
            &close,
            &conditional_proof,
        );

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &mark_price(&env),
            &new_position,
            &margin_output,
            &proof,
        );

        assert!(client.is_settled(&close));
        assert!(client.is_position_spent(&nullifier));
    }

    #[test]
    fn records_manual_position_close_without_conditional_trigger() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let new_position = BytesN::from_array(&env, &[4; 32]);
        let margin_output = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(&env);
        let setup = setup_protocol(&env, &id, Some(&proof), None);

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        env.set_auths(&[]);
        client.settle_manual(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &mark_price(&env),
            &new_position,
            &margin_output,
            &proof,
        );

        assert!(client.is_settled(&close));
        assert!(client.is_position_spent(&nullifier));
        let state = PositionStateClient::new(&env, &setup.position_state);
        assert_eq!(state.leaf_count(), 2);
        assert!(state.has_root(&position_root(&env)));
    }

    #[test]
    fn records_manual_position_close_with_high_byte_commitments() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = high_bytes(&env, 0);
        let close = high_bytes(&env, 1);
        let new_position = high_bytes(&env, 2);
        let margin_output = high_bytes(&env, 3);
        let proof = proof_for(&env, &nullifier, &close, &new_position, &margin_output);
        let setup = setup_protocol(&env, &id, Some(&proof), None);

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle_manual(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &mark_price(&env),
            &new_position,
            &margin_output,
            &proof,
        );

        assert!(client.is_settled(&close));
        assert!(client.is_position_spent(&nullifier));
    }

    #[test]
    #[should_panic(expected = "position already spent")]
    fn rejects_duplicate_position_nullifier() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let next_close = BytesN::from_array(&env, &[9; 32]);
        let new_position = BytesN::from_array(&env, &[4; 32]);
        let margin_output = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(&env);
        let next_proof = proof_for(&env, &nullifier, &next_close, &new_position, &margin_output);
        let conditional_proof = conditional_proof(&env);
        let next_conditional_proof = conditional_proof_for(&env, &nullifier, &next_close);
        let setup = setup_protocol(&env, &id, Some(&proof), Some(&conditional_proof));
        record_position_proof(&env, &setup, &next_proof);
        record_conditional_proof(&env, &setup, &next_conditional_proof);

        trigger_conditional_order(
            &env,
            &setup.conditional_order,
            &market,
            &nullifier,
            &close,
            &conditional_proof,
        );
        trigger_conditional_order(
            &env,
            &setup.conditional_order,
            &market,
            &nullifier,
            &next_close,
            &next_conditional_proof,
        );

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &mark_price(&env),
            &new_position,
            &margin_output,
            &proof,
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &next_close,
            &mark_price(&env),
            &new_position,
            &margin_output,
            &next_proof,
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let proof = proof(&env);
        let setup = setup_protocol(&env, &id, None, None);

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &BytesN::from_array(&env, &[1; 32]),
            &position_root(&env),
            &position_commitment(&env),
            &BytesN::from_array(&env, &[2; 32]),
            &BytesN::from_array(&env, &[3; 32]),
            &mark_price(&env),
            &BytesN::from_array(&env, &[4; 32]),
            &BytesN::from_array(&env, &[5; 32]),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let proof = proof(&env);
        let wrong_verifier = BytesN::from_array(&env, &[11; 32]);
        let setup = setup_protocol_with_verifiers(
            &env,
            &id,
            &wrong_verifier,
            &conditional_verifier(&env),
            None,
            None,
        );

        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &BytesN::from_array(&env, &[1; 32]),
            &position_root(&env),
            &position_commitment(&env),
            &BytesN::from_array(&env, &[2; 32]),
            &BytesN::from_array(&env, &[3; 32]),
            &mark_price(&env),
            &BytesN::from_array(&env, &[4; 32]),
            &BytesN::from_array(&env, &[5; 32]),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "conditional close not triggered")]
    fn rejects_untriggered_conditional_close() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);
        let setup = setup_protocol(&env, &id, Some(&proof), None);

        register_conditional_order(&env, &setup.conditional_order, &market, &nullifier, &close);
        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &mark_price(&env),
            &BytesN::from_array(&env, &[4; 32]),
            &BytesN::from_array(&env, &[5; 32]),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "conditional close not triggered")]
    fn rejects_trigger_for_different_position() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let triggered_nullifier = BytesN::from_array(&env, &[2; 32]);
        let settling_nullifier = BytesN::from_array(&env, &[9; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof_for(
            &env,
            &settling_nullifier,
            &close,
            &BytesN::from_array(&env, &[4; 32]),
            &BytesN::from_array(&env, &[5; 32]),
        );
        let conditional_proof = conditional_proof(&env);
        let setup = setup_protocol(&env, &id, Some(&proof), Some(&conditional_proof));

        trigger_conditional_order(
            &env,
            &setup.conditional_order,
            &market,
            &triggered_nullifier,
            &close,
            &conditional_proof,
        );
        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &settling_nullifier,
            &close,
            &mark_price(&env),
            &BytesN::from_array(&env, &[4; 32]),
            &BytesN::from_array(&env, &[5; 32]),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "mark price mismatch")]
    fn rejects_close_argument_mismatch() {
        let env = Env::default();
        let id = env.register(PositionClose, ());
        let client = PositionCloseClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let new_position = BytesN::from_array(&env, &[4; 32]);
        let margin_output = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(&env);
        let conditional_proof = conditional_proof(&env);
        let setup = setup_protocol(&env, &id, Some(&proof), Some(&conditional_proof));

        trigger_conditional_order(
            &env,
            &setup.conditional_order,
            &market,
            &nullifier,
            &close,
            &conditional_proof,
        );
        client.init(
            &setup.governance,
            &setup.proof_ledger,
            &setup.conditional_order,
            &setup.market,
            &setup.position_state,
            &circuit(&env),
        );
        client.settle(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &close,
            &57_000_00000000,
            &new_position,
            &margin_output,
            &proof,
        );
    }

    fn proof(env: &Env) -> ProofMeta {
        proof_for(
            env,
            &BytesN::from_array(env, &[2; 32]),
            &BytesN::from_array(env, &[3; 32]),
            &BytesN::from_array(env, &[4; 32]),
            &BytesN::from_array(env, &[5; 32]),
        )
    }

    fn proof_for(
        env: &Env,
        nullifier: &BytesN<32>,
        close: &BytesN<32>,
        new_position: &BytesN<32>,
        margin_output: &BytesN<32>,
    ) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[6; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::position_close_public_input_hash(
                env,
                mark_price(env) as u128,
                super::PRICE_SCALE,
                &position_root(env),
                &position_commitment(env),
                nullifier,
                close,
                new_position,
                margin_output,
            ),
            proof_digest: BytesN::from_array(env, &[9; 32]),
        }
    }

    fn mark_price(_env: &Env) -> i128 {
        56_000_00000000
    }

    fn position_root(env: &Env) -> BytesN<32> {
        let mut node = position_commitment(env);
        let mut empty = BytesN::from_array(env, &[0; 32]);
        for _ in 0..20 {
            node = position_hash_pair(env, &node, &empty);
            empty = position_hash_pair(env, &empty, &empty);
        }
        node
    }

    fn position_commitment(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[9; 32])
    }

    fn position_hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
        let left = Bn254Fr::from_bytes(left.clone());
        let right = Bn254Fr::from_bytes(right.clone());
        let left_factor = Bn254Fr::from_u256(U256::from_u32(env, 131));
        let right_factor = Bn254Fr::from_u256(U256::from_u32(env, 137));
        let domain = Bn254Fr::from_u256(U256::from_u32(env, 17));
        (left
            .mul(left_factor)
            .add(right.mul(right_factor))
            .add(domain))
        .to_bytes()
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[10; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7; 32])
    }

    fn high_bytes(env: &Env, last: u8) -> BytesN<32> {
        let mut value = [0xff; 32];
        value[31] = last;
        BytesN::from_array(env, &value)
    }

    fn conditional_proof(env: &Env) -> ConditionalProofMeta {
        conditional_proof_for(
            env,
            &BytesN::from_array(env, &[2; 32]),
            &BytesN::from_array(env, &[3; 32]),
        )
    }

    fn conditional_proof_for(
        env: &Env,
        nullifier: &BytesN<32>,
        close: &BytesN<32>,
    ) -> ConditionalProofMeta {
        ConditionalProofMeta {
            circuit_id: conditional_circuit(env),
            circuit_hash: BytesN::from_array(env, &[12; 32]),
            verifier_hash: conditional_verifier(env),
            public_input_hash: conditional_order::conditional_close_public_input_hash(
                env,
                mark_price(env) as u128,
                nullifier,
                close,
            ),
            proof_digest: BytesN::from_array(env, &[15; 32]),
        }
    }

    fn conditional_circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[11; 32])
    }

    fn conditional_verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[13; 32])
    }

    fn setup_protocol(
        env: &Env,
        writer: &Address,
        position_proof: Option<&ProofMeta>,
        conditional_proof: Option<&ConditionalProofMeta>,
    ) -> ProtocolSetup {
        setup_protocol_with_verifiers(
            env,
            writer,
            &verifier(env),
            &conditional_verifier(env),
            position_proof,
            conditional_proof,
        )
    }

    fn setup_protocol_with_verifiers(
        env: &Env,
        writer: &Address,
        position_verifier_hash: &BytesN<32>,
        conditional_verifier_hash: &BytesN<32>,
        position_proof: Option<&ProofMeta>,
        conditional_proof: Option<&ConditionalProofMeta>,
    ) -> ProtocolSetup {
        env.mock_all_auths();
        let position_authority = Address::generate(env);
        let conditional_authority = Address::generate(env);
        let governance = setup_governance_with_authorities(
            env,
            position_verifier_hash,
            &position_authority,
            conditional_verifier_hash,
            &conditional_authority,
        );
        let proof_ledger = setup_proof_ledger_with_proofs(
            env,
            &governance,
            &position_authority,
            position_proof,
            &conditional_authority,
            conditional_proof,
        );
        let market = setup_market(env, &BytesN::from_array(env, &[1; 32]), &governance);
        let conditional_order = setup_conditional_order(env, &governance, &proof_ledger, &market);
        let position_state = setup_position_state(env, writer, &governance);

        ProtocolSetup {
            conditional_authority,
            governance,
            market,
            proof_ledger,
            conditional_order,
            position_state,
            position_authority,
        }
    }

    fn setup_position_state(env: &Env, writer: &Address, governance: &Address) -> Address {
        env.mock_all_auths();
        let id = env.register(PositionState, ());
        let state = PositionStateClient::new(env, &id);
        state.init(governance);
        state.set_writer(writer, &true);
        let appended = state.append(writer, &position_commitment(env));
        assert_eq!(appended.root, position_root(env));
        id
    }

    fn record_position_proof(env: &Env, setup: &ProtocolSetup, proof: &ProofMeta) {
        let ledger = ProofLedgerClient::new(env, &setup.proof_ledger);
        ledger.record(
            &setup.position_authority,
            &proof.circuit_id,
            &proof.verifier_hash,
            &proof.public_input_hash,
            &proof.proof_digest,
        );
    }

    fn record_conditional_proof(env: &Env, setup: &ProtocolSetup, proof: &ConditionalProofMeta) {
        let ledger = ProofLedgerClient::new(env, &setup.proof_ledger);
        ledger.record(
            &setup.conditional_authority,
            &proof.circuit_id,
            &proof.verifier_hash,
            &proof.public_input_hash,
            &proof.proof_digest,
        );
    }

    fn setup_governance_with_authorities(
        env: &Env,
        position_verifier_hash: &BytesN<32>,
        position_authority: &Address,
        conditional_verifier_hash: &BytesN<32>,
        conditional_authority: &Address,
    ) -> Address {
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&circuit(env), position_verifier_hash, position_authority);
        governance.set_verifier(
            &conditional_circuit(env),
            conditional_verifier_hash,
            conditional_authority,
        );
        governance_id
    }

    fn setup_proof_ledger_with_proofs(
        env: &Env,
        governance: &Address,
        position_authority: &Address,
        position_proof: Option<&ProofMeta>,
        conditional_authority: &Address,
        conditional_proof: Option<&ConditionalProofMeta>,
    ) -> Address {
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(env, &ledger_id);

        ledger.init(governance);
        if let Some(proof) = position_proof {
            ledger.record(
                position_authority,
                &proof.circuit_id,
                &proof.verifier_hash,
                &proof.public_input_hash,
                &proof.proof_digest,
            );
        }
        if let Some(proof) = conditional_proof {
            ledger.record(
                conditional_authority,
                &proof.circuit_id,
                &proof.verifier_hash,
                &proof.public_input_hash,
                &proof.proof_digest,
            );
        }
        ledger_id
    }

    fn setup_market(env: &Env, market_id: &BytesN<32>, governance: &Address) -> Address {
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle_id = env.register(TestOracle, ());
        let oracle = TestOracleClient::new(env, &oracle_id);
        oracle.init(&8);
        oracle.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &mark_price(env),
            &950,
        );

        let market_contract = env.register(Market, ());
        let market = MarketClient::new(env, &market_contract);
        market.init(governance);
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
            &true,
        );
        market_contract
    }

    fn setup_conditional_order(
        env: &Env,
        governance: &Address,
        proof_ledger: &Address,
        market: &Address,
    ) -> Address {
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderRegistryClient::new(env, &id);
        client.init(governance, proof_ledger, market, &conditional_circuit(env));
        id
    }

    fn register_conditional_order(
        env: &Env,
        conditional_order: &Address,
        market: &BytesN<32>,
        nullifier: &BytesN<32>,
        close: &BytesN<32>,
    ) {
        let client = ConditionalOrderRegistryClient::new(env, conditional_order);
        client.register(market, nullifier, close);
    }

    fn trigger_conditional_order(
        env: &Env,
        conditional_order: &Address,
        market: &BytesN<32>,
        nullifier: &BytesN<32>,
        close: &BytesN<32>,
        proof: &ConditionalProofMeta,
    ) {
        let client = ConditionalOrderRegistryClient::new(env, conditional_order);
        client.register(market, nullifier, close);
        client.trigger(market, nullifier, close, &mark_price(env), proof);
    }
}
