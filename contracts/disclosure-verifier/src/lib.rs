#![no_std]

use governance_interface::GovernanceClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, Bytes, BytesN, Env, U256,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Disclosure(BytesN<32>),
    Governance,
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
pub struct DisclosureMeta {
    pub subject: BytesN<32>,
    pub claim: BytesN<32>,
    pub root: BytesN<32>,
    pub threshold: i128,
    pub proof: ProofMeta,
}

#[contract]
pub struct DisclosureVerifier;

#[contractimpl]
impl DisclosureVerifier {
    pub fn init(env: Env, governance: Address, proof_ledger: Address, circuit_id: BytesN<32>) {
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
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn verify(
        env: Env,
        disclosure_id: BytesN<32>,
        subject: BytesN<32>,
        claim: BytesN<32>,
        root: BytesN<32>,
        threshold: i128,
        proof: ProofMeta,
    ) {
        if threshold < 0 {
            panic!("invalid threshold");
        }
        validate_proof(&env, &proof);
        validate_public_inputs(&env, threshold, &subject, &claim, &root, &proof);
        let key = DataKey::Disclosure(disclosure_id.clone());
        if env.storage().persistent().has(&key) {
            panic!("duplicate disclosure");
        }
        env.storage().persistent().set(
            &key,
            &DisclosureMeta {
                subject,
                claim,
                root,
                threshold,
                proof,
            },
        );
    }

    pub fn has_disclosure(env: Env, disclosure_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Disclosure(disclosure_id))
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
    threshold: i128,
    subject: &BytesN<32>,
    claim: &BytesN<32>,
    root: &BytesN<32>,
    proof: &ProofMeta,
) {
    let expected = disclosure_public_input_hash(env, threshold as u128, subject, claim, root);
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn disclosure_public_input_hash(
    env: &Env,
    threshold: u128,
    subject: &BytesN<32>,
    claim: &BytesN<32>,
    root: &BytesN<32>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_u128_field(env, &mut public_inputs, threshold);
    append_field(&mut public_inputs, subject);
    append_field(&mut public_inputs, claim);
    append_field(&mut public_inputs, root);
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

    use super::{DisclosureVerifier, DisclosureVerifierClient, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    #[test]
    fn records_disclosure() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &circuit(&env),
        );
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
        assert!(client.has_disclosure(&disclosure));
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_disclosure_argument_mismatch() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &circuit(&env),
        );
        client.verify(&disclosure, &subject, &claim, &root, &101, &proof);
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_proof() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = empty_proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &circuit(&env),
        );
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance_with_verifier(&env, &BytesN::from_array(&env, &[11; 32])),
            &setup_proof_ledger(&env, Some(&proof)),
            &circuit(&env),
        );
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "circuit mismatch")]
    fn rejects_wrong_circuit() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &BytesN::from_array(&env, &[11; 32]),
        );
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_protocol() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);
        let governance = setup_governance(&env);
        let proof_ledger = setup_proof_ledger(&env, Some(&proof));
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        client.init(&governance, &proof_ledger, &circuit(&env));
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(DisclosureVerifier, ());
        let client = DisclosureVerifierClient::new(&env, &id);
        let disclosure = BytesN::from_array(&env, &[1; 32]);
        let subject = BytesN::from_array(&env, &[2; 32]);
        let claim = BytesN::from_array(&env, &[3; 32]);
        let root = BytesN::from_array(&env, &[4; 32]);
        let proof = proof(&env);

        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &circuit(&env),
        );
        client.verify(
            &disclosure,
            &subject,
            &claim,
            &root,
            &threshold(&env),
            &proof,
        );
    }

    fn proof(env: &Env) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[6; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::disclosure_public_input_hash(
                env,
                threshold(env) as u128,
                &BytesN::from_array(env, &[2; 32]),
                &BytesN::from_array(env, &[3; 32]),
                &BytesN::from_array(env, &[4; 32]),
            ),
            proof_digest: BytesN::from_array(env, &[9; 32]),
        }
    }

    fn threshold(_env: &Env) -> i128 {
        100
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7; 32])
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
