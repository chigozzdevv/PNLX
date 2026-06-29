#![no_std]

use governance_interface::GovernanceClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env,
};
use ultrahonk_verifier::{UltraHonkVerifier, VkLoadError, PROOF_BYTES};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Governance,
    ProofLedger,
    CircuitId,
    VerifierHash,
    Vk,
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    InvalidHash = 2,
    VkHashMismatch = 3,
    VkInvalidLength = 4,
    VkInvalidParameters = 5,
    ProofParseError = 6,
    VerificationFailed = 7,
    Paused = 8,
    VerifierMismatch = 9,
    UnauthorizedVerifier = 10,
    PublicInputMismatch = 11,
    ProofDigestMismatch = 12,
    NotInitialized = 13,
}

#[contract]
pub struct ProofVerifier;

#[contractimpl]
impl ProofVerifier {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        vk_bytes: Bytes,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Vk) {
            return Err(Error::AlreadyInitialized);
        }
        validate_hash(&env, &circuit_id)?;
        validate_hash(&env, &verifier_hash)?;
        if env.crypto().sha256(&vk_bytes).to_bytes() != verifier_hash {
            return Err(Error::VkHashMismatch);
        }
        parse_vk(&env, &vk_bytes)?;

        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage()
            .instance()
            .set(&DataKey::ProofLedger, &proof_ledger);
        env.storage()
            .instance()
            .set(&DataKey::CircuitId, &circuit_id);
        env.storage()
            .instance()
            .set(&DataKey::VerifierHash, &verifier_hash);
        env.storage().instance().set(&DataKey::Vk, &vk_bytes);
        Ok(())
    }

    pub fn verify_and_record(
        env: Env,
        public_inputs: Bytes,
        proof_bytes: Bytes,
        public_input_hash: BytesN<32>,
        proof_digest: BytesN<32>,
    ) -> Result<(), Error> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(Error::ProofParseError);
        }
        validate_hash(&env, &public_input_hash)?;
        validate_hash(&env, &proof_digest)?;

        let vk_bytes = Self::vk_bytes(env.clone())?;
        let verifier_hash = Self::verifier_hash(env.clone())?;
        if env.crypto().sha256(&public_inputs).to_bytes() != public_input_hash {
            return Err(Error::PublicInputMismatch);
        }
        if env.crypto().sha256(&proof_bytes).to_bytes() != proof_digest {
            return Err(Error::ProofDigestMismatch);
        }

        let governance_id = Self::governance(env.clone())?;
        let governance = GovernanceClient::new(&env, &governance_id);
        let circuit_id = Self::circuit_id(env.clone())?;
        let authority = env.current_contract_address();
        if governance.paused() {
            return Err(Error::Paused);
        }
        if governance.verifier(&circuit_id) != verifier_hash {
            return Err(Error::VerifierMismatch);
        }
        if governance.verifier_authority(&circuit_id) != authority {
            return Err(Error::UnauthorizedVerifier);
        }

        let verifier = parse_vk(&env, &vk_bytes)?;
        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| Error::VerificationFailed)?;

        ProofLedgerClient::new(&env, &Self::proof_ledger(env.clone())?).record(
            &authority,
            &circuit_id,
            &verifier_hash,
            &public_input_hash,
            &proof_digest,
        );
        Ok(())
    }

    pub fn governance(env: Env) -> Result<Address, Error> {
        get_address(&env, DataKey::Governance)
    }

    pub fn proof_ledger(env: Env) -> Result<Address, Error> {
        get_address(&env, DataKey::ProofLedger)
    }

    pub fn circuit_id(env: Env) -> Result<BytesN<32>, Error> {
        get_hash(&env, DataKey::CircuitId)
    }

    pub fn verifier_hash(env: Env) -> Result<BytesN<32>, Error> {
        get_hash(&env, DataKey::VerifierHash)
    }

    pub fn vk_hash(env: Env) -> Result<BytesN<32>, Error> {
        let vk = Self::vk_bytes(env.clone())?;
        Ok(env.crypto().sha256(&vk).to_bytes())
    }

    pub fn vk_bytes(env: Env) -> Result<Bytes, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Vk)
            .ok_or(Error::NotInitialized)
    }
}

fn parse_vk(env: &Env, vk_bytes: &Bytes) -> Result<UltraHonkVerifier, Error> {
    UltraHonkVerifier::new(env, vk_bytes).map_err(|e| match e {
        VkLoadError::WrongLength => Error::VkInvalidLength,
        VkLoadError::InvalidParameters => Error::VkInvalidParameters,
    })
}

fn validate_hash(env: &Env, value: &BytesN<32>) -> Result<(), Error> {
    if *value == BytesN::from_array(env, &[0; 32]) {
        return Err(Error::InvalidHash);
    }
    Ok(())
}

fn get_address(env: &Env, key: DataKey) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&key)
        .ok_or(Error::NotInitialized)
}

fn get_hash(env: &Env, key: DataKey) -> Result<BytesN<32>, Error> {
    env.storage()
        .instance()
        .get(&key)
        .ok_or(Error::NotInitialized)
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{Error, ProofVerifier, ProofVerifierClient};
    use governance::{Governance, GovernanceClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

    fn bytes32(env: &Env, raw: &[u8]) -> BytesN<32> {
        let mut out = [0u8; 32];
        out.copy_from_slice(raw);
        BytesN::from_array(env, &out)
    }

    fn setup(
        env: &Env,
    ) -> (
        ProofVerifierClient<'_>,
        ProofLedgerClient<'_>,
        Bytes,
        Bytes,
        BytesN<32>,
        BytesN<32>,
    ) {
        env.mock_all_auths();
        let vk = Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/withdraw/target/bb/vk"),
        );
        let proof = Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/withdraw/target/bb/proof"),
        );
        let public_inputs = Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/withdraw/target/bb/public_inputs"),
        );
        let circuit_id = BytesN::from_array(env, &[9; 32]);
        let verifier_hash = env.crypto().sha256(&vk).to_bytes();
        let public_input_hash = env.crypto().sha256(&public_inputs).to_bytes();
        let proof_digest = env.crypto().sha256(&proof).to_bytes();

        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let proof_ledger_id = env.register(ProofLedger, ());
        let proof_ledger = ProofLedgerClient::new(env, &proof_ledger_id);
        let verifier_id = env.register(ProofVerifier, ());
        let verifier = ProofVerifierClient::new(env, &verifier_id);
        let admin = Address::generate(env);

        governance.init(&admin);
        proof_ledger.init(&governance_id);
        governance.set_verifier(&circuit_id, &verifier_hash, &verifier_id);
        verifier.init(
            &governance_id,
            &proof_ledger_id,
            &circuit_id,
            &verifier_hash,
            &vk,
        );
        env.set_auths(&[]);

        (
            verifier,
            proof_ledger,
            public_inputs,
            proof,
            public_input_hash,
            proof_digest,
        )
    }

    #[test]
    fn verifies_and_records_real_proof() {
        let env = Env::default();
        let (verifier, proof_ledger, public_inputs, proof, public_hash, proof_hash) = setup(&env);
        let circuit_id = verifier.circuit_id();
        let verifier_hash = verifier.verifier_hash();

        verifier.verify_and_record(&public_inputs, &proof, &public_hash, &proof_hash);

        assert!(proof_ledger.has_proof(&circuit_id, &verifier_hash, &public_hash, &proof_hash));
    }

    #[test]
    fn rejects_public_input_mismatch() {
        let env = Env::default();
        let (verifier, _, public_inputs, proof, _, proof_hash) = setup(&env);
        let wrong = bytes32(&env, &[7; 32]);

        let err = verifier
            .try_verify_and_record(&public_inputs, &proof, &wrong, &proof_hash)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, Error::PublicInputMismatch);
    }

    #[test]
    fn rejects_proof_digest_mismatch() {
        let env = Env::default();
        let (verifier, _, public_inputs, proof, public_hash, _) = setup(&env);
        let wrong = bytes32(&env, &[8; 32]);

        let err = verifier
            .try_verify_and_record(&public_inputs, &proof, &public_hash, &wrong)
            .unwrap_err()
            .unwrap();

        assert_eq!(err, Error::ProofDigestMismatch);
    }
}
