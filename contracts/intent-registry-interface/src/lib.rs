#![no_std]

use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "IntentRegistryClient")]
pub trait IntentRegistryInterface {
    fn cancel(env: Env, intent_commitment: BytesN<32>);
    fn consume(env: Env, settler: Address, intent_commitment: BytesN<32>);
    fn has_intent(env: Env, intent_commitment: BytesN<32>) -> bool;
    fn is_cancelled(env: Env, intent_commitment: BytesN<32>) -> bool;
    fn is_active_intent(env: Env, intent_commitment: BytesN<32>) -> bool;
    fn submission_sequence(env: Env, intent_commitment: BytesN<32>) -> u64;
    fn matching_payload_commitment(env: Env, intent_commitment: BytesN<32>) -> BytesN<32>;
    fn rollover(
        env: Env,
        settler: Address,
        source: BytesN<32>,
        residual: BytesN<32>,
        matching_payload_commitment: BytesN<32>,
    );
}
