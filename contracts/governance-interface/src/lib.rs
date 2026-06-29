#![no_std]

use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "GovernanceClient")]
pub trait GovernanceInterface {
    fn admin(env: Env) -> Address;
    fn paused(env: Env) -> bool;
    fn verifier(env: Env, circuit_id: BytesN<32>) -> BytesN<32>;
    fn verifier_authority(env: Env, circuit_id: BytesN<32>) -> Address;
}
