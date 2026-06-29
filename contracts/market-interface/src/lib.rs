#![no_std]

use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MarketPrice {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "MarketClient")]
pub trait MarketInterface {
    fn advance_funding(
        env: Env,
        updater: Address,
        market_id: BytesN<32>,
        old_index: i128,
        new_index: i128,
    );
    fn funding_index(env: Env, market_id: BytesN<32>) -> i128;
    fn is_active(env: Env, market_id: BytesN<32>) -> bool;
    fn mark_price(env: Env, market_id: BytesN<32>) -> MarketPrice;
}
