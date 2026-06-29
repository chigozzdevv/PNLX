#![no_std]

use governance_interface::GovernanceClient;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Governance,
    Proof(BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>),
}

#[contract]
pub struct ProofLedger;

#[contractimpl]
impl ProofLedger {
    pub fn init(env: Env, governance: Address) {
        if env.storage().instance().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
    }

    pub fn record(
        env: Env,
        verifier_authority: Address,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        public_input_hash: BytesN<32>,
        proof_digest: BytesN<32>,
    ) {
        verifier_authority.require_auth();
        validate_hash(&env, &circuit_id);
        validate_hash(&env, &verifier_hash);
        validate_hash(&env, &public_input_hash);
        validate_hash(&env, &proof_digest);

        let governance = GovernanceClient::new(&env, &Self::governance(env.clone()));
        if governance.paused() {
            panic!("paused");
        }
        if governance.verifier(&circuit_id) != verifier_hash {
            panic!("verifier mismatch");
        }
        if governance.verifier_authority(&circuit_id) != verifier_authority {
            panic!("unauthorized verifier");
        }

        env.storage().persistent().set(
            &DataKey::Proof(circuit_id, verifier_hash, public_input_hash, proof_digest),
            &true,
        );
    }

    pub fn has_proof(
        env: Env,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        public_input_hash: BytesN<32>,
        proof_digest: BytesN<32>,
    ) -> bool {
        env.storage().persistent().has(&DataKey::Proof(
            circuit_id,
            verifier_hash,
            public_input_hash,
            proof_digest,
        ))
    }

    pub fn governance(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid proof");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{ProofLedger, ProofLedgerClient};
    use governance::{Governance, GovernanceClient};
    use soroban_sdk::{
        crypto::bn254::{Bn254Fr, Bn254G1Affine},
        testutils::Address as _,
        Address, BytesN, Env, U256,
    };

    #[test]
    fn records_proof_digest() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let public = BytesN::from_array(&env, &[3; 32]);
        let proof = BytesN::from_array(&env, &[4; 32]);
        let authority = Address::generate(&env);
        let governance = setup_governance(&env, &circuit, &verifier, &authority);

        client.init(&governance);
        client.record(&authority, &circuit, &verifier, &public, &proof);

        assert!(client.has_proof(&circuit, &verifier, &public, &proof));
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn rejects_double_init() {
        let env = Env::default();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let governance = Address::generate(&env);

        client.init(&governance);
        client.init(&governance);
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_digest() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let public = BytesN::from_array(&env, &[3; 32]);
        let empty = BytesN::from_array(&env, &[0; 32]);
        let authority = Address::generate(&env);
        let governance = setup_governance(&env, &circuit, &verifier, &authority);

        client.init(&governance);
        client.record(&authority, &circuit, &verifier, &public, &empty);
    }

    #[test]
    #[should_panic(expected = "unauthorized verifier")]
    fn rejects_wrong_authority() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let public = BytesN::from_array(&env, &[3; 32]);
        let proof = BytesN::from_array(&env, &[4; 32]);
        let authority = Address::generate(&env);
        let wrong = Address::generate(&env);
        let governance = setup_governance(&env, &circuit, &verifier, &authority);

        client.init(&governance);
        client.record(&wrong, &circuit, &verifier, &public, &proof);
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let wrong_verifier = BytesN::from_array(&env, &[7; 32]);
        let public = BytesN::from_array(&env, &[3; 32]);
        let proof = BytesN::from_array(&env, &[4; 32]);
        let authority = Address::generate(&env);
        let governance = setup_governance(&env, &circuit, &verifier, &authority);

        client.init(&governance);
        client.record(&authority, &circuit, &wrong_verifier, &public, &proof);
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_governance() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProofLedger, ());
        let client = ProofLedgerClient::new(&env, &id);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let public = BytesN::from_array(&env, &[3; 32]);
        let proof = BytesN::from_array(&env, &[4; 32]);
        let authority = Address::generate(&env);
        let governance = setup_governance(&env, &circuit, &verifier, &authority);
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        client.init(&governance);
        client.record(&authority, &circuit, &verifier, &public, &proof);
    }

    #[test]
    fn exposes_bn254_host_functions() {
        let env = Env::default();
        let bn254 = env.crypto().bn254();
        let generator = Bn254G1Affine::from_array(
            &env,
            &[
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 2,
            ],
        );
        let scalar: Bn254Fr = U256::from_u32(&env, 2).into();

        assert_eq!(
            bn254.g1_add(&generator, &generator),
            bn254.g1_mul(&generator, &scalar),
        );
    }

    fn setup_governance(
        env: &Env,
        circuit: &BytesN<32>,
        verifier: &BytesN<32>,
        authority: &Address,
    ) -> Address {
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(circuit, verifier, authority);
        governance_id
    }
}
