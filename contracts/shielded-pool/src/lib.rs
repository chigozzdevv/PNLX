#![no_std]

use governance_interface::GovernanceClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, token::Client as TokenClient, xdr::ToXdr, Address, Bytes,
    BytesN, Env, U256,
};

const BN254_SCALAR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

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
pub enum DataKey {
    Commitment(BytesN<32>),
    Nullifier(BytesN<32>),
    AssetWithdrawal(BytesN<32>),
    Withdrawal(BytesN<32>),
    Governance,
    ProofLedger,
    DepositCircuit,
    WithdrawCircuit,
    Writer(Address),
    FeeReserve(Address),
}

#[derive(Clone)]
#[contracttype]
pub struct FeeReserve {
    pub insurance: i128,
    pub treasury: i128,
}

#[contract]
pub struct ShieldedPool;

#[contractimpl]
impl ShieldedPool {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        deposit_circuit_id: BytesN<32>,
        withdraw_circuit_id: BytesN<32>,
    ) {
        validate_hash(&env, &deposit_circuit_id);
        validate_hash(&env, &withdraw_circuit_id);
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
            .set(&DataKey::DepositCircuit, &deposit_circuit_id);
        env.storage()
            .persistent()
            .set(&DataKey::WithdrawCircuit, &withdraw_circuit_id);
    }

    pub fn deposit(env: Env, commitment: BytesN<32>) {
        record_commitment(&env, commitment);
    }

    pub fn set_writer(env: Env, writer: Address, enabled: bool) {
        require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Writer(writer), &enabled);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let governance_id: Address = env.storage().persistent().get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"));
        GovernanceClient::new(&env, &governance_id).upgrade_authority().require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn deposit_asset(
        env: Env,
        token: Address,
        from: Address,
        amount: i128,
        commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        if amount <= 0 {
            panic!("invalid amount");
        }
        validate_hash(&env, &commitment);
        validate_proof(&env, &proof, DataKey::DepositCircuit);
        let token_digest = address_digest(&env, &token);
        validate_deposit_public_inputs(&env, amount, &token_digest, &commitment, &proof);
        from.require_auth();
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        record_commitment(&env, commitment);
    }

    pub fn deposit_claim(
        env: Env,
        writer: Address,
        token: Address,
        amount: i128,
        commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        require_writer(&env, writer);
        if amount <= 0 {
            panic!("invalid amount");
        }
        validate_hash(&env, &commitment);
        validate_proof(&env, &proof, DataKey::DepositCircuit);
        let token_digest = address_digest(&env, &token);
        validate_deposit_public_inputs(&env, amount, &token_digest, &commitment, &proof);
        record_commitment(&env, commitment);
    }

    pub fn token_digest(env: Env, token: Address) -> BytesN<32> {
        address_digest(&env, &token)
    }

    pub fn has_commitment(env: Env, commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Commitment(commitment))
    }

    pub fn spend(env: Env, writer: Address, nullifier: BytesN<32>) {
        require_writer(&env, writer);
        record_nullifier(&env, nullifier);
    }

    pub fn accrue_fees(env: Env, writer: Address, token: Address, insurance: i128, treasury: i128) {
        writer.require_auth();
        if !env
            .storage()
            .persistent()
            .get(&DataKey::Writer(writer))
            .unwrap_or(false)
        {
            panic!("unauthorized writer");
        }
        if insurance < 0 || treasury < 0 {
            panic!("negative fee reserve");
        }
        let key = DataKey::FeeReserve(token.clone());
        let mut reserve = Self::fee_reserve(env.clone(), token.clone());
        reserve.insurance = reserve
            .insurance
            .checked_add(insurance)
            .expect("insurance overflow");
        reserve.treasury = reserve
            .treasury
            .checked_add(treasury)
            .expect("treasury overflow");
        if TokenClient::new(&env, &token).balance(&env.current_contract_address())
            < reserve
                .insurance
                .checked_add(reserve.treasury)
                .expect("fee reserve overflow")
        {
            panic!("fee reserve exceeds pool balance");
        }
        env.storage().persistent().set(&key, &reserve);
    }

    pub fn fee_reserve(env: Env, token: Address) -> FeeReserve {
        env.storage()
            .persistent()
            .get(&DataKey::FeeReserve(token))
            .unwrap_or(FeeReserve {
                insurance: 0,
                treasury: 0,
            })
    }

    pub fn withdraw_insurance(env: Env, token: Address, recipient: Address, amount: i128) {
        release_fee_reserve(&env, token, recipient, amount, true);
    }

    pub fn withdraw_treasury(env: Env, token: Address, recipient: Address, amount: i128) {
        release_fee_reserve(&env, token, recipient, amount, false);
    }

    pub fn withdraw(
        env: Env,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        token_digest: BytesN<32>,
        recipient: BytesN<32>,
        amount: i128,
        proof: ProofMeta,
        change_commitment: BytesN<32>,
    ) {
        if amount <= 0 {
            panic!("invalid amount");
        }
        validate_proof(&env, &proof, DataKey::WithdrawCircuit);
        validate_public_inputs(
            &env,
            amount,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change_commitment,
            &proof,
        );
        record_nullifier(&env, nullifier.clone());
        env.storage().persistent().set(
            &DataKey::Withdrawal(nullifier),
            &(root, recipient, amount, proof),
        );
        record_change_commitment(&env, change_commitment);
    }

    pub fn withdraw_asset(
        env: Env,
        token: Address,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        recipient: Address,
        amount: i128,
        proof: ProofMeta,
        change_commitment: BytesN<32>,
    ) {
        if amount <= 0 {
            panic!("invalid amount");
        }
        validate_proof(&env, &proof, DataKey::WithdrawCircuit);
        let token_digest = address_digest(&env, &token);
        let recipient_digest = address_digest(&env, &recipient);
        validate_public_inputs(
            &env,
            amount,
            &root,
            &nullifier,
            &token_digest,
            &recipient_digest,
            &change_commitment,
            &proof,
        );
        record_nullifier(&env, nullifier.clone());
        let reserve = Self::fee_reserve(env.clone(), token.clone());
        let reserved = reserve
            .insurance
            .checked_add(reserve.treasury)
            .expect("fee reserve overflow");
        let balance = TokenClient::new(&env, &token).balance(&env.current_contract_address());
        if balance.checked_sub(amount).unwrap_or(-1) < reserved {
            panic!("withdrawal would consume fee reserve");
        }
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        env.storage().persistent().set(
            &DataKey::AssetWithdrawal(nullifier),
            &(token, root, recipient, amount, proof),
        );
        record_change_commitment(&env, change_commitment);
    }

    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    pub fn has_withdrawal(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Withdrawal(nullifier))
    }

    pub fn has_asset_withdrawal(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::AssetWithdrawal(nullifier))
    }
}

fn require_writer(env: &Env, writer: Address) {
    writer.require_auth();
    if !env
        .storage()
        .persistent()
        .get(&DataKey::Writer(writer))
        .unwrap_or(false)
    {
        panic!("unauthorized writer");
    }
}

fn require_admin(env: &Env) {
    let governance_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Governance)
        .unwrap_or_else(|| panic!("not initialized"));
    GovernanceClient::new(env, &governance_id)
        .admin()
        .require_auth();
}

fn release_fee_reserve(
    env: &Env,
    token: Address,
    recipient: Address,
    amount: i128,
    insurance: bool,
) {
    require_admin(env);
    if amount <= 0 {
        panic!("invalid fee withdrawal");
    }
    let key = DataKey::FeeReserve(token.clone());
    let mut reserve = ShieldedPool::fee_reserve(env.clone(), token.clone());
    let balance = if insurance {
        &mut reserve.insurance
    } else {
        &mut reserve.treasury
    };
    if *balance < amount {
        panic!("insufficient fee reserve");
    }
    *balance -= amount;
    env.storage().persistent().set(&key, &reserve);
    TokenClient::new(env, &token).transfer(&env.current_contract_address(), &recipient, &amount);
}

fn record_commitment(env: &Env, commitment: BytesN<32>) {
    let key = DataKey::Commitment(commitment.clone());
    if env.storage().persistent().has(&key) {
        panic!("duplicate commitment");
    }
    env.storage().persistent().set(&key, &true);
}

fn record_nullifier(env: &Env, nullifier: BytesN<32>) {
    let key = DataKey::Nullifier(nullifier.clone());
    if env.storage().persistent().has(&key) {
        panic!("duplicate nullifier");
    }
    env.storage().persistent().set(&key, &true);
}

fn record_change_commitment(env: &Env, change_commitment: BytesN<32>) {
    if change_commitment != BytesN::from_array(env, &[0; 32]) {
        record_commitment(env, change_commitment);
    }
}

fn validate_proof(env: &Env, proof: &ProofMeta, circuit_key: DataKey) {
    validate_hash(env, &proof.circuit_id);
    validate_hash(env, &proof.circuit_hash);
    validate_hash(env, &proof.verifier_hash);
    validate_hash(env, &proof.public_input_hash);
    validate_hash(env, &proof.proof_digest);

    let circuit_id: BytesN<32> = env
        .storage()
        .persistent()
        .get(&circuit_key)
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

fn validate_deposit_public_inputs(
    env: &Env,
    amount: i128,
    token_digest: &BytesN<32>,
    commitment: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = deposit_public_input_hash(env, amount, token_digest, commitment);
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn validate_public_inputs(
    env: &Env,
    amount: i128,
    root: &BytesN<32>,
    nullifier: &BytesN<32>,
    token_digest: &BytesN<32>,
    recipient_digest: &BytesN<32>,
    change_commitment: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = withdraw_public_input_hash(
        env,
        amount,
        root,
        nullifier,
        token_digest,
        recipient_digest,
        change_commitment,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn deposit_public_input_hash(
    env: &Env,
    amount: i128,
    token_digest: &BytesN<32>,
    commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, amount as u128);
    append_field(env, &mut public_inputs, token_digest);
    append_field(env, &mut public_inputs, commitment);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn withdraw_public_input_hash(
    env: &Env,
    amount: i128,
    root: &BytesN<32>,
    nullifier: &BytesN<32>,
    token_digest: &BytesN<32>,
    recipient_digest: &BytesN<32>,
    change_commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, amount as u128);
    append_field(env, &mut public_inputs, root);
    append_field(env, &mut public_inputs, nullifier);
    append_field(env, &mut public_inputs, token_digest);
    append_field(env, &mut public_inputs, recipient_digest);
    append_field(env, &mut public_inputs, change_commitment);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn append_u128_field(env: &Env, out: &mut Bytes, value: u128) {
    let encoded = U256::from_u128(env, value).to_be_bytes();
    out.append(&encoded);
}

fn append_field(env: &Env, out: &mut Bytes, value: &BytesN<32>) {
    out.append(&field_bytes(env, value));
}

fn address_digest(env: &Env, address: &Address) -> BytesN<32> {
    let digest = env.crypto().sha256(&address.clone().to_xdr(env)).to_bytes();
    BytesN::<32>::try_from(field_bytes(env, &digest)).unwrap()
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

    use super::{
        address_digest, deposit_public_input_hash, withdraw_public_input_hash, ProofMeta,
        ShieldedPool, ShieldedPoolClient,
    };
    use governance::{Governance, GovernanceClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, BytesN, Env,
    };

    #[test]
    fn deposit_and_spend() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let writer = Address::generate(&env);
        let commitment = BytesN::from_array(&env, &[7; 32]);
        let nullifier = BytesN::from_array(&env, &[9; 32]);

        client.init(
            &setup_governance(&env),
            &Address::generate(&env),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.set_writer(&writer, &true);
        client.deposit(&commitment);
        assert!(client.has_commitment(&commitment));

        client.spend(&writer, &nullifier);
        assert!(client.is_spent(&nullifier));
    }

    #[test]
    fn deposit_asset_moves_collateral_into_pool() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let admin = Address::generate(&env);
        let trader = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin).address();
        let token = TokenClient::new(&env, &token_id);
        let token_admin = StellarAssetClient::new(&env, &token_id);
        let commitment = BytesN::from_array(&env, &[7; 32]);
        let token_digest = address_digest(&env, &token_id);
        let proof = deposit_proof(&env, 4_000, &token_digest, &commitment);

        token_admin.mint(&trader, &10_000);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.deposit_asset(&token_id, &trader, &4_000, &commitment, &proof);

        assert!(client.has_commitment(&commitment));
        assert_eq!(token.balance(&trader), 6_000);
        assert_eq!(token.balance(&id), 4_000);
    }

    #[test]
    fn claim_deposit_registers_only_a_proven_note_from_an_authorized_writer() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let writer = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let commitment = BytesN::from_array(&env, &[61; 32]);
        let proof = deposit_proof(&env, 4_000, &address_digest(&env, &token_id), &commitment);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.set_writer(&writer, &true);
        assert!(client
            .try_deposit_claim(&writer, &token_id, &3_999, &commitment, &proof)
            .is_err());
        assert!(!client.has_commitment(&commitment));
        client.deposit_claim(&writer, &token_id, &4_000, &commitment, &proof);
        assert!(client.has_commitment(&commitment));
        assert_eq!(TokenClient::new(&env, &token_id).balance(&id), 0);
    }

    #[test]
    fn withdraws_with_change() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
        assert!(client.is_spent(&nullifier));
        assert!(client.has_withdrawal(&nullifier));
        assert!(client.has_commitment(&change));
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_withdrawal_argument_mismatch() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let wrong_recipient = BytesN::from_array(&env, &[9; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &wrong_recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    #[test]
    fn withdraw_asset_moves_collateral_to_recipient() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let admin = Address::generate(&env);
        let trader = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin).address();
        let token = TokenClient::new(&env, &token_id);
        let token_admin = StellarAssetClient::new(&env, &token_id);
        let commitment = BytesN::from_array(&env, &[7; 32]);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let change = BytesN::from_array(&env, &[5; 32]);
        let token_digest = address_digest(&env, &token_id);
        let recipient_digest = address_digest(&env, &recipient);
        let deposit_proof = deposit_proof(&env, 4_000, &token_digest, &commitment);
        let proof = proof(
            &env,
            1_500,
            &root,
            &nullifier,
            &token_digest,
            &recipient_digest,
            &change,
        );

        token_admin.mint(&trader, &10_000);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger_many(&env, &[&deposit_proof, &proof]),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.deposit_asset(&token_id, &trader, &4_000, &commitment, &deposit_proof);
        client.withdraw_asset(
            &token_id, &root, &nullifier, &recipient, &1_500, &proof, &change,
        );

        assert!(client.is_spent(&nullifier));
        assert!(client.has_asset_withdrawal(&nullifier));
        assert!(client.has_commitment(&change));
        assert_eq!(token.balance(&recipient), 1_500);
        assert_eq!(token.balance(&id), 2_500);
    }

    #[test]
    #[should_panic(expected = "withdrawal would consume fee reserve")]
    fn prevents_private_withdrawal_from_consuming_fee_reserves() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let writer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let token_admin = StellarAssetClient::new(&env, &token_id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            3_001,
            &root,
            &nullifier,
            &address_digest(&env, &token_id),
            &address_digest(&env, &recipient),
            &change,
        );
        token_admin.mint(&id, &4_000);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.set_writer(&writer, &true);
        client.accrue_fees(&writer, &token_id, &400, &600);
        assert_eq!(client.fee_reserve(&token_id).insurance, 400);
        assert_eq!(client.fee_reserve(&token_id).treasury, 600);
        client.withdraw_asset(
            &token_id, &root, &nullifier, &recipient, &3_001, &proof, &change,
        );
    }

    #[test]
    fn releases_only_the_selected_fee_reserve() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let writer = Address::generate(&env);
        let treasury_recipient = Address::generate(&env);
        let insurance_recipient = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let token = TokenClient::new(&env, &token_id);
        StellarAssetClient::new(&env, &token_id).mint(&id, &4_000);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.set_writer(&writer, &true);
        client.accrue_fees(&writer, &token_id, &400, &600);

        client.withdraw_treasury(&token_id, &treasury_recipient, &250);
        client.withdraw_insurance(&token_id, &insurance_recipient, &100);

        let reserve = client.fee_reserve(&token_id);
        assert_eq!(reserve.insurance, 300);
        assert_eq!(reserve.treasury, 350);
        assert_eq!(token.balance(&treasury_recipient), 250);
        assert_eq!(token.balance(&insurance_recipient), 100);
        assert_eq!(token.balance(&id), 3_650);
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_asset_withdrawal_recipient_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let admin = Address::generate(&env);
        let trader = Address::generate(&env);
        let recipient = Address::generate(&env);
        let wrong_recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin).address();
        let token_admin = StellarAssetClient::new(&env, &token_id);
        let commitment = BytesN::from_array(&env, &[7; 32]);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let change = BytesN::from_array(&env, &[5; 32]);
        let token_digest = address_digest(&env, &token_id);
        let recipient_digest = address_digest(&env, &recipient);
        let deposit_proof = deposit_proof(&env, 4_000, &token_digest, &commitment);
        let proof = proof(
            &env,
            1_500,
            &root,
            &nullifier,
            &token_digest,
            &recipient_digest,
            &change,
        );

        token_admin.mint(&trader, &10_000);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger_many(&env, &[&deposit_proof, &proof]),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.deposit_asset(&token_id, &trader, &4_000, &commitment, &deposit_proof);
        client.withdraw_asset(
            &token_id,
            &root,
            &nullifier,
            &wrong_recipient,
            &1_500,
            &proof,
            &change,
        );
    }

    #[test]
    #[should_panic(expected = "duplicate nullifier")]
    fn rejects_duplicate_nullifier() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let writer = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[3; 32]);

        client.init(
            &setup_governance(&env),
            &Address::generate(&env),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.set_writer(&writer, &true);
        client.spend(&writer, &nullifier);
        client.spend(&writer, &nullifier);
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_withdrawal_proof() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = empty_proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_withdrawal_verifier() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );

        client.init(
            &setup_governance_with_verifier(&env, &BytesN::from_array(&env, &[11; 32])),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    #[test]
    #[should_panic(expected = "circuit mismatch")]
    fn rejects_wrong_withdrawal_circuit() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &deposit_circuit(&env),
            &BytesN::from_array(&env, &[11; 32]),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_withdrawal() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );
        let governance = setup_governance(&env);
        let proof_ledger = setup_proof_ledger(&env, Some(&proof));
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        client.init(
            &governance,
            &proof_ledger,
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_withdrawal_proof() {
        let env = Env::default();
        let id = env.register(ShieldedPool, ());
        let client = ShieldedPoolClient::new(&env, &id);
        let root = root(&env);
        let nullifier = BytesN::from_array(&env, &[8; 32]);
        let recipient = BytesN::from_array(&env, &[7; 32]);
        let token_digest = zero(&env);
        let change = BytesN::from_array(&env, &[5; 32]);
        let proof = proof(
            &env,
            4_000,
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &change,
        );

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &deposit_circuit(&env),
            &circuit(&env),
        );
        client.withdraw(
            &root,
            &nullifier,
            &token_digest,
            &recipient,
            &4_000,
            &proof,
            &change,
        );
    }

    fn proof(
        env: &Env,
        amount: i128,
        root: &BytesN<32>,
        nullifier: &BytesN<32>,
        token_digest: &BytesN<32>,
        recipient_digest: &BytesN<32>,
        change_commitment: &BytesN<32>,
    ) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[7; 32]),
            verifier_hash: verifier(env),
            public_input_hash: withdraw_public_input_hash(
                env,
                amount,
                root,
                nullifier,
                token_digest,
                recipient_digest,
                change_commitment,
            ),
            proof_digest: BytesN::from_array(env, &[10; 32]),
        }
    }

    fn deposit_proof(
        env: &Env,
        amount: i128,
        token_digest: &BytesN<32>,
        commitment: &BytesN<32>,
    ) -> ProofMeta {
        ProofMeta {
            circuit_id: deposit_circuit(env),
            circuit_hash: BytesN::from_array(env, &[7; 32]),
            verifier_hash: verifier(env),
            public_input_hash: deposit_public_input_hash(env, amount, token_digest, commitment),
            proof_digest: BytesN::from_array(env, &[12; 32]),
        }
    }

    fn root(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[4; 32])
    }

    fn zero(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0; 32])
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[6; 32])
    }

    fn deposit_circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[8; 32])
    }

    fn setup_governance(env: &Env) -> Address {
        setup_governance_with_verifier(env, &verifier(env))
    }

    fn setup_governance_with_verifier(env: &Env, verifier_hash: &BytesN<32>) -> Address {
        env.mock_all_auths();
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);
        let authority = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&deposit_circuit(env), verifier_hash, &authority);
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
        match proof {
            Some(proof) => {
                setup_proof_ledger_with_governance(env, &governance, &authority, &[proof])
            }
            None => setup_proof_ledger_with_governance(env, &governance, &authority, &[]),
        }
    }

    fn setup_proof_ledger_many(env: &Env, proofs: &[&ProofMeta]) -> Address {
        env.mock_all_auths();
        let authority = Address::generate(env);
        let governance = setup_governance_with_authority(env, &verifier(env), &authority);
        setup_proof_ledger_with_governance(env, &governance, &authority, proofs)
    }

    fn setup_proof_ledger_with_governance(
        env: &Env,
        governance: &Address,
        authority: &Address,
        proofs: &[&ProofMeta],
    ) -> Address {
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(env, &ledger_id);

        ledger.init(governance);
        for proof in proofs.iter() {
            let proof = *proof;
            ledger.record(
                authority,
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
        governance.set_verifier(&deposit_circuit(env), verifier_hash, authority);
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
