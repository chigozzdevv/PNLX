#![no_std]

use soroban_sdk::{contractclient, BytesN, Env};

#[contractclient(name = "ConditionalOrderClient")]
pub trait ConditionalOrderInterface {
    fn is_registered(env: Env, close_commitment: BytesN<32>) -> bool;
    fn is_triggered(env: Env, close_commitment: BytesN<32>) -> bool;
    fn is_triggered_for(
        env: Env,
        market_id: BytesN<32>,
        position_nullifier: BytesN<32>,
        close_commitment: BytesN<32>,
    ) -> bool;
}
