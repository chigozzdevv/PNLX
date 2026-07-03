#![no_std]

use soroban_sdk::{contractclient, BytesN, Env};

#[contractclient(name = "IntentRegistryClient")]
pub trait IntentRegistryInterface {
    fn cancel(env: Env, intent_commitment: BytesN<32>);
    fn has_intent(env: Env, intent_commitment: BytesN<32>) -> bool;
    fn is_cancelled(env: Env, intent_commitment: BytesN<32>) -> bool;
    fn is_active_intent(env: Env, intent_commitment: BytesN<32>) -> bool;
}
