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
    Circuit,
    Funding(BytesN<32>, i128, i128),
    Governance,
    MarketContract,
    ProofLedger,
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
pub struct FundingSettlementMeta {
    pub elapsed_ms: u64,
    pub interval_ms: u64,
    pub mark_price: i128,
    pub max_delta: i128,
    pub max_delta_enabled: bool,
    pub new_index: i128,
    pub old_index: i128,
    pub premium_rate: i128,
    pub proof: ProofMeta,
}

#[contract]
pub struct FundingSettlement;

#[contractimpl]
impl FundingSettlement {
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

    pub fn settle(
        env: Env,
        market_id: BytesN<32>,
        old_index: i128,
        new_index: i128,
        mark_price: i128,
        premium_rate: i128,
        elapsed_ms: u64,
        interval_ms: u64,
        max_delta: i128,
        max_delta_enabled: bool,
        proof: ProofMeta,
    ) {
        validate_hash(&env, &market_id);
        if new_index == old_index {
            panic!("invalid funding index");
        }
        if mark_price <= 0 {
            panic!("invalid mark price");
        }
        if max_delta < 0 || elapsed_ms == 0 || interval_ms == 0 {
            panic!("invalid funding params");
        }
        if max_delta_enabled && max_delta == 0 {
            panic!("invalid funding cap");
        }
        validate_oracle_mark_price(&env, &market_id, mark_price);
        validate_proof(&env, &proof);
        validate_public_inputs(
            &env,
            &market_id,
            old_index,
            new_index,
            mark_price,
            premium_rate,
            elapsed_ms,
            interval_ms,
            max_delta,
            max_delta_enabled,
            &proof,
        );

        let key = DataKey::Funding(market_id.clone(), old_index, new_index);
        if env.storage().persistent().has(&key) {
            panic!("funding already settled");
        }

        let market_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::MarketContract)
            .unwrap_or_else(|| panic!("not initialized"));
        MarketClient::new(&env, &market_contract).advance_funding(
            &env.current_contract_address(),
            &market_id,
            &old_index,
            &new_index,
        );
        env.storage().persistent().set(
            &key,
            &FundingSettlementMeta {
                elapsed_ms,
                interval_ms,
                mark_price,
                max_delta,
                max_delta_enabled,
                new_index,
                old_index,
                premium_rate,
                proof,
            },
        );
    }

    pub fn is_settled(env: Env, market_id: BytesN<32>, old_index: i128, new_index: i128) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Funding(market_id, old_index, new_index))
    }
}

fn validate_oracle_mark_price(env: &Env, market_id: &BytesN<32>, mark_price: i128) {
    let market_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::MarketContract)
        .unwrap_or_else(|| panic!("not initialized"));
    let market = MarketClient::new(env, &market_contract);
    let current = market.mark_price(market_id);
    if current.price != mark_price {
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
    market_id: &BytesN<32>,
    old_index: i128,
    new_index: i128,
    mark_price: i128,
    premium_rate: i128,
    elapsed_ms: u64,
    interval_ms: u64,
    max_delta: i128,
    max_delta_enabled: bool,
    proof: &ProofMeta,
) {
    let expected = funding_public_input_hash(
        env,
        market_id,
        old_index,
        new_index,
        mark_price as u128,
        premium_rate,
        elapsed_ms as u128,
        interval_ms as u128,
        max_delta as u128,
        if max_delta_enabled { 1 } else { 0 },
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn funding_public_input_hash(
    env: &Env,
    market_id: &BytesN<32>,
    old_index: i128,
    new_index: i128,
    mark_price: u128,
    premium_rate: i128,
    elapsed_ms: u128,
    interval_ms: u128,
    max_delta: u128,
    max_delta_enabled: u128,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_field(&mut public_inputs, market_id);
    append_i128_fields(env, &mut public_inputs, old_index);
    append_i128_fields(env, &mut public_inputs, new_index);
    append_u128_field(env, &mut public_inputs, mark_price);
    append_i128_fields(env, &mut public_inputs, premium_rate);
    append_u128_field(env, &mut public_inputs, elapsed_ms);
    append_u128_field(env, &mut public_inputs, interval_ms);
    append_u128_field(env, &mut public_inputs, max_delta);
    append_u128_field(env, &mut public_inputs, max_delta_enabled);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn append_i128_fields(env: &Env, out: &mut Bytes, value: i128) {
    if value < 0 {
        append_u128_field(env, out, (-value) as u128);
        append_u128_field(env, out, 1);
    } else {
        append_u128_field(env, out, value as u128);
        append_u128_field(env, out, 0);
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
        panic!("invalid hash");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{FundingSettlement, FundingSettlementClient, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use market::{Market, MarketClient};
    use mock_oracle::{MockOracle, MockOracleClient};
    use oracle_interface::OracleAsset;
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol,
    };

    #[test]
    fn settles_funding_update() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(FundingSettlement, ());
        let client = FundingSettlementClient::new(&env, &id);
        let market_id = BytesN::from_array(&env, &[8; 32]);
        let proof = proof(&env, &market_id, 1_000, 1_500, 50_000_00000000);
        let governance = setup_governance(&env, &proof);
        let proof_ledger = setup_proof_ledger(&env, &governance, &proof);
        let market = setup_market(&env, &governance, &market_id, 1_000);
        MarketClient::new(&env, &market).set_funding_updater(&id, &true);
        client.init(&governance, &proof_ledger, &market, &circuit(&env));

        client.settle(
            &market_id,
            &1_000,
            &1_500,
            &50_000_00000000,
            &10_000,
            &3_600_000,
            &3_600_000,
            &0,
            &false,
            &proof,
        );

        assert!(client.is_settled(&market_id, &1_000, &1_500));
        assert_eq!(
            MarketClient::new(&env, &market).funding_index(&market_id),
            1_500
        );
    }

    #[test]
    fn settles_negative_funding_update() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(FundingSettlement, ());
        let client = FundingSettlementClient::new(&env, &id);
        let market_id = BytesN::from_array(&env, &[8; 32]);
        let proof = proof_with_rate(&env, &market_id, 1_000, 500, 50_000_00000000, -10_000);
        let governance = setup_governance(&env, &proof);
        let proof_ledger = setup_proof_ledger(&env, &governance, &proof);
        let market = setup_market(&env, &governance, &market_id, 1_000);
        MarketClient::new(&env, &market).set_funding_updater(&id, &true);
        client.init(&governance, &proof_ledger, &market, &circuit(&env));

        client.settle(
            &market_id,
            &1_000,
            &500,
            &50_000_00000000,
            &-10_000,
            &3_600_000,
            &3_600_000,
            &0,
            &false,
            &proof,
        );

        assert!(client.is_settled(&market_id, &1_000, &500));
        assert_eq!(
            MarketClient::new(&env, &market).funding_index(&market_id),
            500
        );
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_argument_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(FundingSettlement, ());
        let client = FundingSettlementClient::new(&env, &id);
        let market_id = BytesN::from_array(&env, &[8; 32]);
        let proof = proof(&env, &market_id, 1_000, 1_500, 50_000_00000000);
        let governance = setup_governance(&env, &proof);
        let proof_ledger = setup_proof_ledger(&env, &governance, &proof);
        let market = setup_market(&env, &governance, &market_id, 1_000);
        MarketClient::new(&env, &market).set_funding_updater(&id, &true);
        client.init(&governance, &proof_ledger, &market, &circuit(&env));

        client.settle(
            &market_id,
            &1_000,
            &1_501,
            &50_000_00000000,
            &10_000,
            &3_600_000,
            &3_600_000,
            &0,
            &false,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "mark price mismatch")]
    fn rejects_stale_mark_price() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(FundingSettlement, ());
        let client = FundingSettlementClient::new(&env, &id);
        let market_id = BytesN::from_array(&env, &[8; 32]);
        let proof = proof(&env, &market_id, 1_000, 1_500, 50_000_00000000);
        let governance = setup_governance(&env, &proof);
        let proof_ledger = setup_proof_ledger(&env, &governance, &proof);
        let market = setup_market(&env, &governance, &market_id, 1_000);
        MarketClient::new(&env, &market).set_funding_updater(&id, &true);
        client.init(&governance, &proof_ledger, &market, &circuit(&env));

        client.settle(
            &market_id,
            &1_000,
            &1_500,
            &49_000_00000000,
            &10_000,
            &3_600_000,
            &3_600_000,
            &0,
            &false,
            &proof,
        );
    }

    fn proof(
        env: &Env,
        market_id: &BytesN<32>,
        old_index: i128,
        new_index: i128,
        mark_price: i128,
    ) -> ProofMeta {
        proof_with_rate(env, market_id, old_index, new_index, mark_price, 10_000)
    }

    fn proof_with_rate(
        env: &Env,
        market_id: &BytesN<32>,
        old_index: i128,
        new_index: i128,
        mark_price: i128,
        premium_rate: i128,
    ) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[6; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::funding_public_input_hash(
                env,
                market_id,
                old_index,
                new_index,
                mark_price as u128,
                premium_rate,
                3_600_000,
                3_600_000,
                0,
                0,
            ),
            proof_digest: BytesN::from_array(env, &[9; 32]),
        }
    }

    fn setup_governance(env: &Env, proof: &ProofMeta) -> Address {
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(env, &id);
        let admin = Address::generate(env);
        let verifier_authority = Address::generate(env);
        client.init(&admin);
        client.set_verifier(&proof.circuit_id, &proof.verifier_hash, &verifier_authority);
        id
    }

    fn setup_proof_ledger(env: &Env, governance: &Address, proof: &ProofMeta) -> Address {
        let ledger = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(env, &ledger);
        let governance_client = GovernanceClient::new(env, governance);
        let authority = governance_client.verifier_authority(&proof.circuit_id);
        client.init(governance);
        client.record(
            &authority,
            &proof.circuit_id,
            &proof.verifier_hash,
            &proof.public_input_hash,
            &proof.proof_digest,
        );
        ledger
    }

    fn setup_market(
        env: &Env,
        governance: &Address,
        market_id: &BytesN<32>,
        funding_index: i128,
    ) -> Address {
        let oracle = env.register(MockOracle, ());
        let oracle_client = MockOracleClient::new(env, &oracle);
        oracle_client.init(&8);
        oracle_client.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &50_000_00000000,
            &950,
        );

        let market = env.register(Market, ());
        let client = MarketClient::new(env, &market);
        client.init(governance);
        client.upsert_other(
            market_id,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &funding_index,
            &true,
        );
        market
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7; 32])
    }
}
