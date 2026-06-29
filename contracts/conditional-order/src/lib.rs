#![no_std]

use governance_interface::GovernanceClient;
use market_interface::MarketClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, Bytes, BytesN, Env, U256,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Order(BytesN<32>),
    Trigger(BytesN<32>),
    Governance,
    MarketContract,
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
pub struct ConditionalOrderMeta {
    pub market_id: BytesN<32>,
    pub position_nullifier: BytesN<32>,
}

#[derive(Clone)]
#[contracttype]
pub struct ConditionalTriggerMeta {
    pub market_id: BytesN<32>,
    pub mark_price: i128,
    pub position_nullifier: BytesN<32>,
    pub proof: ProofMeta,
}

#[contract]
pub struct ConditionalOrder;

#[contractimpl]
impl ConditionalOrder {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        market_contract: Address,
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
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn register(
        env: Env,
        market_id: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
    ) {
        ensure_initialized(&env);
        validate_hash(&env, &market_id);
        validate_hash(&env, &position_nullifier);
        validate_hash(&env, &close_commitment);

        let key = DataKey::Order(close_commitment);
        if env.storage().persistent().has(&key) {
            panic!("conditional order exists");
        }
        env.storage().persistent().set(
            &key,
            &ConditionalOrderMeta {
                market_id,
                position_nullifier,
            },
        );
    }

    pub fn trigger(
        env: Env,
        market_id: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
        mark_price: i128,
        proof: ProofMeta,
    ) {
        validate_hash(&env, &market_id);
        validate_hash(&env, &position_nullifier);
        validate_hash(&env, &close_commitment);
        if mark_price <= 0 {
            panic!("invalid mark price");
        }
        let order_key = DataKey::Order(close_commitment.clone());
        let order: ConditionalOrderMeta = env
            .storage()
            .persistent()
            .get(&order_key)
            .unwrap_or_else(|| panic!("conditional order not registered"));
        if order.market_id != market_id || order.position_nullifier != position_nullifier {
            panic!("conditional order mismatch");
        }
        validate_oracle_mark_price(&env, &market_id, mark_price);
        validate_proof(&env, &proof);
        validate_public_inputs(
            &env,
            mark_price,
            &position_nullifier,
            &close_commitment,
            &proof,
        );

        let trigger_key = DataKey::Trigger(close_commitment);
        if env.storage().persistent().has(&trigger_key) {
            panic!("conditional order already triggered");
        }
        env.storage().persistent().set(
            &trigger_key,
            &ConditionalTriggerMeta {
                market_id,
                mark_price,
                position_nullifier,
                proof,
            },
        );
    }

    pub fn is_registered(env: Env, close_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Order(close_commitment))
    }

    pub fn is_triggered(env: Env, close_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Trigger(close_commitment))
    }

    pub fn is_triggered_for(
        env: Env,
        market_id: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
    ) -> bool {
        let trigger: Option<ConditionalTriggerMeta> = env
            .storage()
            .persistent()
            .get(&DataKey::Trigger(close_commitment));
        match trigger {
            Some(trigger) => {
                trigger.market_id == market_id && trigger.position_nullifier == position_nullifier
            }
            None => false,
        }
    }
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

fn ensure_initialized(env: &Env) {
    if !env.storage().persistent().has(&DataKey::Governance) {
        panic!("not initialized");
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
    position_nullifier: &BytesN<32>,
    close_commitment: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = conditional_close_public_input_hash(
        env,
        mark_price as u128,
        position_nullifier,
        close_commitment,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

pub fn conditional_close_public_input_hash(
    env: &Env,
    mark_price: u128,
    position_nullifier: &BytesN<32>,
    close_commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, mark_price);
    append_field(&mut public_inputs, position_nullifier);
    append_field(&mut public_inputs, close_commitment);
    env.crypto().sha256(&public_inputs).to_bytes()
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

    use super::{ConditionalOrder, ConditionalOrderClient, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use market::{Market, MarketClient};
    use test_oracle::{TestOracle, TestOracleClient};
    use oracle_interface::OracleAsset;
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol,
    };

    #[test]
    fn registers_and_triggers_conditional_order() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        assert!(client.is_registered(&close));
        assert!(!client.is_triggered(&close));

        client.trigger(&market, &nullifier, &close, &mark_price(&env), &proof);
        assert!(client.is_triggered(&close));
        assert!(client.is_triggered_for(&market, &nullifier, &close));
        assert!(!client.is_triggered_for(&BytesN::from_array(&env, &[9; 32]), &nullifier, &close,));
    }

    #[test]
    #[should_panic(expected = "conditional order exists")]
    fn rejects_duplicate_registration() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        client.register(&market, &nullifier, &close);
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn rejects_registration_before_init() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);

        client.register(
            &BytesN::from_array(&env, &[1; 32]),
            &BytesN::from_array(&env, &[2; 32]),
            &BytesN::from_array(&env, &[3; 32]),
        );
    }

    #[test]
    #[should_panic(expected = "conditional order not registered")]
    fn rejects_unregistered_trigger() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &BytesN::from_array(&env, &[1; 32])),
            &circuit(&env),
        );
        client.trigger(
            &BytesN::from_array(&env, &[1; 32]),
            &BytesN::from_array(&env, &[2; 32]),
            &BytesN::from_array(&env, &[3; 32]),
            &mark_price(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "conditional order mismatch")]
    fn rejects_mismatched_trigger() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        client.trigger(
            &BytesN::from_array(&env, &[9; 32]),
            &nullifier,
            &close,
            &mark_price(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "mark price mismatch")]
    fn rejects_trigger_argument_mismatch() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        client.trigger(&market, &nullifier, &close, &57_000_00000000, &proof);
    }

    #[test]
    #[should_panic(expected = "conditional order already triggered")]
    fn rejects_duplicate_trigger() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        client.trigger(&market, &nullifier, &close, &mark_price(&env), &proof);
        client.trigger(&market, &nullifier, &close, &mark_price(&env), &proof);
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(ConditionalOrder, ());
        let client = ConditionalOrderClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[1; 32]);
        let nullifier = BytesN::from_array(&env, &[2; 32]);
        let close = BytesN::from_array(&env, &[3; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market),
            &circuit(&env),
        );
        client.register(&market, &nullifier, &close);
        client.trigger(&market, &nullifier, &close, &mark_price(&env), &proof);
    }

    fn proof(env: &Env) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[7; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::conditional_close_public_input_hash(
                env,
                mark_price(env) as u128,
                &BytesN::from_array(env, &[2; 32]),
                &BytesN::from_array(env, &[3; 32]),
            ),
            proof_digest: BytesN::from_array(env, &[10; 32]),
        }
    }

    fn mark_price(_env: &Env) -> i128 {
        56_000_00000000
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[6; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[8; 32])
    }

    fn setup_governance(env: &Env) -> Address {
        setup_governance_with_authority(env, &verifier(env), &Address::generate(env))
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
}
