#![no_std]

use governance_interface::GovernanceClient;
use market_interface::MarketClient;
use position_state_interface::PositionStateClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
    U256,
};

const PRICE_SCALE: u128 = 100_000_000;
const RATE_SCALE: u128 = 1_000_000;
const BN254_SCALAR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Liquidated(BytesN<32>),
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
pub struct LiquidationMeta {
    pub market_id: BytesN<32>,
    pub mark_price: i128,
    pub maintenance_rate: i128,
    pub position_commitment: BytesN<32>,
    pub position_root: BytesN<32>,
    pub proof: ProofMeta,
    pub reward_commitment: BytesN<32>,
}

#[contract]
pub struct Liquidation;

#[contractimpl]
impl Liquidation {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
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
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .persistent()
            .set(&DataKey::PositionState, &position_state);
        env.storage()
            .persistent()
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn liquidate(
        env: Env,
        market_id: BytesN<32>,
        position_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
        mark_price: i128,
        maintenance_rate: i128,
        proof: ProofMeta,
        reward_commitment: BytesN<32>,
    ) {
        validate_hash(&env, &market_id);
        validate_hash(&env, &position_root);
        validate_hash(&env, &position_commitment);
        validate_hash(&env, &position_nullifier);
        validate_hash(&env, &reward_commitment);
        if mark_price <= 0 {
            panic!("invalid mark price");
        }
        if maintenance_rate <= 0 {
            panic!("invalid maintenance rate");
        }
        validate_oracle_mark_price(&env, &market_id, mark_price);
        validate_proof(&env, &proof);
        validate_public_inputs(
            &env,
            mark_price,
            maintenance_rate,
            &position_root,
            &position_commitment,
            &position_nullifier,
            &reward_commitment,
            &proof,
        );
        let key = DataKey::Liquidated(position_nullifier.clone());
        if env.storage().persistent().has(&key) {
            panic!("already liquidated");
        }
        spend_position(
            &env,
            &position_root,
            &position_commitment,
            &position_nullifier,
        );
        let meta = LiquidationMeta {
            market_id,
            mark_price,
            maintenance_rate,
            position_commitment,
            position_root,
            proof,
            reward_commitment,
        };
        env.storage().persistent().set(&key, &meta);
    }

    pub fn is_liquidated(env: Env, position_nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Liquidated(position_nullifier))
    }
}

fn spend_position(
    env: &Env,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
) {
    let position_state_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::PositionState)
        .unwrap_or_else(|| panic!("not initialized"));
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
    PositionStateClient::new(env, &position_state_id).spend_position(
        &writer,
        position_root,
        position_commitment,
        position_nullifier,
    );
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
    maintenance_rate: i128,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    reward_commitment: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = liquidation_public_input_hash(
        env,
        mark_price as u128,
        maintenance_rate as u128,
        position_root,
        position_commitment,
        position_nullifier,
        reward_commitment,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn liquidation_public_input_hash(
    env: &Env,
    mark_price: u128,
    maintenance_rate: u128,
    position_root: &BytesN<32>,
    position_commitment: &BytesN<32>,
    position_nullifier: &BytesN<32>,
    reward_commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, mark_price);
    append_u128_field(env, &mut public_inputs, maintenance_rate);
    append_u128_field(env, &mut public_inputs, PRICE_SCALE);
    append_u128_field(env, &mut public_inputs, RATE_SCALE);
    append_field(env, &mut public_inputs, position_root);
    append_field(env, &mut public_inputs, position_commitment);
    append_field(env, &mut public_inputs, position_nullifier);
    append_field(env, &mut public_inputs, reward_commitment);
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

    use super::{Liquidation, LiquidationClient, ProofMeta};
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

    #[test]
    fn records_liquidation() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
        assert!(client.is_liquidated(&nullifier));
    }

    #[test]
    #[should_panic(expected = "mark price mismatch")]
    fn rejects_liquidation_argument_mismatch() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &41_000_00000000,
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "already liquidated")]
    fn rejects_duplicate_liquidation() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_proof() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = empty_proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance_with_verifier(&env, &BytesN::from_array(&env, &[11; 32])),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "circuit mismatch")]
    fn rejects_wrong_circuit() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &BytesN::from_array(&env, &[11; 32]),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_protocol() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);
        let governance = setup_governance(&env);
        let proof_ledger = setup_proof_ledger(&env, Some(&proof));
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        client.init(
            &governance,
            &proof_ledger,
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(Liquidation, ());
        let client = LiquidationClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let reward = BytesN::from_array(&env, &[4; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market),
            &setup_position_state(&env, &id),
            &circuit(&env),
        );
        client.liquidate(
            &market,
            &position_root(&env),
            &position_commitment(&env),
            &nullifier,
            &mark_price(&env),
            &maintenance_rate(&env),
            &proof,
            &reward,
        );
    }

    fn proof(env: &Env) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[4; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::liquidation_public_input_hash(
                env,
                mark_price(env) as u128,
                maintenance_rate(env) as u128,
                &position_root(env),
                &position_commitment(env),
                &BytesN::from_array(env, &[2; 32]),
                &BytesN::from_array(env, &[4; 32]),
            ),
            proof_digest: BytesN::from_array(env, &[7; 32]),
        }
    }

    fn mark_price(_env: &Env) -> i128 {
        40_000_00000000
    }

    fn maintenance_rate(_env: &Env) -> i128 {
        100_000
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

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[3; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn setup_governance(env: &Env) -> Address {
        setup_governance_with_verifier(env, &verifier(env))
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

    fn setup_position_state(env: &Env, writer: &Address) -> Address {
        env.mock_all_auths();
        let id = env.register(PositionState, ());
        let state = PositionStateClient::new(env, &id);
        state.init(&setup_governance(env));
        state.set_writer(writer, &true);
        let appended = state.append(writer, &position_commitment(env));
        assert_eq!(appended.root, position_root(env));
        id
    }

    fn setup_market(env: &Env, market_id: &BytesN<32>) -> Address {
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
            &true,
        );
        market_contract
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
