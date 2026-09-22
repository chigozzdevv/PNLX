#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token::Client as TokenClient, Address, Env,
};

const MAX_ALLOCATION_BPS: u32 = 8_000;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_TARGET: u32 = 1_000_000;

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Asset,
    Operator,
    Maker,
    Paused,
    AllocationLimitBps,
    DeployedPrincipal,
    TotalShares,
    Shares(Address),
    PendingShares(Address),
    Deposited(Address),
    Withdrawn(Address),
}

#[contract]
pub struct LiquidityVault;

#[contractimpl]
impl LiquidityVault {
    pub fn __constructor(
        env: Env,
        asset: Address,
        operator: Address,
        maker: Address,
        allocation_limit_bps: u32,
    ) {
        operator.require_auth();
        if allocation_limit_bps == 0 || allocation_limit_bps > MAX_ALLOCATION_BPS {
            panic!("invalid allocation limit");
        }
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::Operator, &operator);
        env.storage().instance().set(&DataKey::Maker, &maker);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage()
            .instance()
            .set(&DataKey::AllocationLimitBps, &allocation_limit_bps);
        env.storage()
            .instance()
            .set(&DataKey::DeployedPrincipal, &0_i128);
        env.storage().instance().set(&DataKey::TotalShares, &0_i128);
        extend_instance(&env);
    }

    pub fn asset(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Asset)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn operator(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Operator)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn maker(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Maker)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn paused(env: Env) -> bool {
        Self::asset(env.clone());
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::operator(env.clone()).require_auth();
        if !paused && Self::deployed_principal(env.clone()) != 0 {
            panic!("allocation outstanding");
        }
        env.storage().instance().set(&DataKey::Paused, &paused);
        extend_instance(&env);
    }

    pub fn liquid_assets(env: Env) -> i128 {
        TokenClient::new(&env, &Self::asset(env.clone())).balance(&env.current_contract_address())
    }

    pub fn deployed_principal(env: Env) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .instance()
            .get(&DataKey::DeployedPrincipal)
            .unwrap_or(0)
    }

    pub fn allocation_limit_bps(env: Env) -> u32 {
        Self::asset(env.clone());
        env.storage()
            .instance()
            .get(&DataKey::AllocationLimitBps)
            .unwrap_or(0)
    }

    pub fn total_assets(env: Env) -> i128 {
        checked_add(
            Self::liquid_assets(env.clone()),
            Self::deployed_principal(env),
        )
    }

    pub fn set_allocation_limit(env: Env, allocation_limit_bps: u32) {
        Self::operator(env.clone()).require_auth();
        if !Self::paused(env.clone()) || Self::deployed_principal(env.clone()) != 0 {
            panic!("vault must be settled and paused");
        }
        if allocation_limit_bps == 0 || allocation_limit_bps > MAX_ALLOCATION_BPS {
            panic!("invalid allocation limit");
        }
        env.storage()
            .instance()
            .set(&DataKey::AllocationLimitBps, &allocation_limit_bps);
        extend_instance(&env);
    }

    pub fn allocate(env: Env, amount: i128) {
        Self::operator(env.clone()).require_auth();
        if !Self::paused(env.clone()) || amount <= 0 || Self::total_shares(env.clone()) == 0 {
            panic!("allocation unavailable");
        }
        let deployed = Self::deployed_principal(env.clone());
        let next = checked_add(deployed, amount);
        let cap = mul_div_floor(
            Self::total_assets(env.clone()),
            Self::allocation_limit_bps(env.clone()) as i128,
            10_000,
        );
        if next > cap || amount > Self::liquid_assets(env.clone()) {
            panic!("allocation exceeds limit");
        }
        TokenClient::new(&env, &Self::asset(env.clone())).transfer(
            &env.current_contract_address(),
            &Self::maker(env.clone()),
            &amount,
        );
        env.storage()
            .instance()
            .set(&DataKey::DeployedPrincipal, &next);
        extend_instance(&env);
    }

    pub fn settle(env: Env, principal: i128, returned: i128) {
        Self::operator(env.clone()).require_auth();
        let deployed = Self::deployed_principal(env.clone());
        if principal <= 0 || principal > deployed || returned <= 0 {
            panic!("invalid settlement");
        }
        TokenClient::new(&env, &Self::asset(env.clone())).transfer(
            &Self::maker(env.clone()),
            &env.current_contract_address(),
            &returned,
        );
        env.storage()
            .instance()
            .set(&DataKey::DeployedPrincipal, &(deployed - principal));
        extend_instance(&env);
    }

    pub fn record_loss(env: Env, principal: i128) {
        Self::operator(env.clone()).require_auth();
        let deployed = Self::deployed_principal(env.clone());
        if principal <= 0 || principal > deployed {
            panic!("invalid loss");
        }
        env.storage()
            .instance()
            .set(&DataKey::DeployedPrincipal, &(deployed - principal));
        extend_instance(&env);
    }

    pub fn total_shares(env: Env) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    pub fn shares(env: Env, owner: Address) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .persistent()
            .get(&DataKey::Shares(owner))
            .unwrap_or(0)
    }

    pub fn pending_shares(env: Env, owner: Address) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .persistent()
            .get(&DataKey::PendingShares(owner))
            .unwrap_or(0)
    }

    pub fn available_shares(env: Env, owner: Address) -> i128 {
        Self::shares(env.clone(), owner.clone()) - Self::pending_shares(env, owner)
    }

    pub fn keep_alive(env: Env, owner: Address) {
        Self::asset(env.clone());
        extend_instance(&env);
        extend_owner(&env, &owner);
    }

    pub fn equity(env: Env, owner: Address) -> i128 {
        if Self::deployed_principal(env.clone()) != 0 {
            panic!("equity unavailable until settlement");
        }
        let shares = Self::shares(env.clone(), owner);
        let supply = Self::total_shares(env.clone());
        if supply == 0 {
            0
        } else {
            mul_div_floor(shares, Self::total_assets(env), supply)
        }
    }

    pub fn deposited(env: Env, owner: Address) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .persistent()
            .get(&DataKey::Deposited(owner))
            .unwrap_or(0)
    }

    pub fn withdrawn(env: Env, owner: Address) -> i128 {
        Self::asset(env.clone());
        env.storage()
            .persistent()
            .get(&DataKey::Withdrawn(owner))
            .unwrap_or(0)
    }

    pub fn recover_unowned(env: Env, recipient: Address) -> i128 {
        Self::operator(env.clone()).require_auth();
        if Self::total_shares(env.clone()) != 0 || Self::deployed_principal(env.clone()) != 0 {
            panic!("shares outstanding");
        }
        let amount = Self::liquid_assets(env.clone());
        if amount > 0 {
            TokenClient::new(&env, &Self::asset(env.clone())).transfer(
                &env.current_contract_address(),
                &recipient,
                &amount,
            );
        }
        extend_instance(&env);
        amount
    }

    pub fn deposit(env: Env, from: Address, amount: i128, min_shares: i128) -> i128 {
        from.require_auth();
        if Self::paused(env.clone()) || Self::deployed_principal(env.clone()) != 0 {
            panic!("vault paused");
        }
        if amount <= 0 || min_shares < 0 {
            panic!("invalid amount");
        }

        let assets = Self::total_assets(env.clone());
        let supply = Self::total_shares(env.clone());
        let minted = if supply == 0 {
            if assets != 0 {
                panic!("unowned assets");
            }
            amount
        } else {
            if assets <= 0 {
                panic!("vault insolvent");
            }
            mul_div_floor(amount, supply, assets)
        };
        if minted == 0 || minted < min_shares {
            panic!("insufficient shares");
        }

        TokenClient::new(&env, &Self::asset(env.clone())).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        let owner_shares = Self::shares(env.clone(), from.clone());
        let prior_deposits = Self::deposited(env.clone(), from.clone());
        env.storage().persistent().set(
            &DataKey::Shares(from.clone()),
            &checked_add(owner_shares, minted),
        );
        env.storage().persistent().set(
            &DataKey::Deposited(from.clone()),
            &checked_add(prior_deposits, amount),
        );
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &checked_add(supply, minted));
        extend_instance(&env);
        extend_owner(&env, &from);
        minted
    }

    pub fn withdraw(env: Env, owner: Address, shares: i128, min_assets: i128) -> i128 {
        owner.require_auth();
        if shares > Self::available_shares(env.clone(), owner.clone()) {
            panic!("shares requested for withdrawal");
        }
        redeem(&env, &owner, shares, min_assets)
    }

    pub fn request_withdraw(env: Env, owner: Address, shares: i128) {
        owner.require_auth();
        if shares <= 0 || shares > Self::available_shares(env.clone(), owner.clone()) {
            panic!("insufficient shares");
        }
        let pending = Self::pending_shares(env.clone(), owner.clone());
        env.storage().persistent().set(
            &DataKey::PendingShares(owner.clone()),
            &checked_add(pending, shares),
        );
        extend_instance(&env);
        extend_owner(&env, &owner);
    }

    pub fn cancel_withdraw_request(env: Env, owner: Address, shares: i128) {
        owner.require_auth();
        let pending = Self::pending_shares(env.clone(), owner.clone());
        if shares <= 0 || shares > pending {
            panic!("insufficient pending shares");
        }
        env.storage()
            .persistent()
            .set(&DataKey::PendingShares(owner.clone()), &(pending - shares));
        extend_instance(&env);
        extend_owner(&env, &owner);
    }

    pub fn claim_withdrawal(env: Env, owner: Address, min_assets: i128) -> i128 {
        owner.require_auth();
        let shares = Self::pending_shares(env.clone(), owner.clone());
        let amount = redeem(&env, &owner, shares, min_assets);
        env.storage()
            .persistent()
            .set(&DataKey::PendingShares(owner.clone()), &0_i128);
        extend_instance(&env);
        extend_owner(&env, &owner);
        amount
    }
}

fn redeem(env: &Env, owner: &Address, shares: i128, min_assets: i128) -> i128 {
    if LiquidityVault::deployed_principal(env.clone()) != 0 {
        panic!("allocation outstanding");
    }
    if shares <= 0 || min_assets < 0 {
        panic!("invalid amount");
    }
    let balance = LiquidityVault::shares(env.clone(), owner.clone());
    if shares > balance {
        panic!("insufficient shares");
    }
    let supply = LiquidityVault::total_shares(env.clone());
    let assets = LiquidityVault::liquid_assets(env.clone());
    let amount = if shares == supply {
        assets
    } else {
        mul_div_floor(shares, assets, supply)
    };
    if (amount == 0 && assets > 0) || amount < min_assets {
        panic!("insufficient assets");
    }

    env.storage()
        .persistent()
        .set(&DataKey::Shares(owner.clone()), &(balance - shares));
    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &(supply - shares));
    let prior_withdrawals = LiquidityVault::withdrawn(env.clone(), owner.clone());
    env.storage().persistent().set(
        &DataKey::Withdrawn(owner.clone()),
        &checked_add(prior_withdrawals, amount),
    );
    TokenClient::new(env, &LiquidityVault::asset(env.clone())).transfer(
        &env.current_contract_address(),
        owner,
        &amount,
    );
    extend_instance(env);
    extend_owner(env, owner);
    amount
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_TARGET);
}

fn extend_owner(env: &Env, owner: &Address) {
    let keys = [
        DataKey::Shares(owner.clone()),
        DataKey::PendingShares(owner.clone()),
        DataKey::Deposited(owner.clone()),
        DataKey::Withdrawn(owner.clone()),
    ];
    for key in keys {
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
    }
}

fn checked_add(left: i128, right: i128) -> i128 {
    left.checked_add(right)
        .unwrap_or_else(|| panic!("amount overflow"))
}

fn mul_div_floor(left: i128, right: i128, denominator: i128) -> i128 {
    if left < 0 || right < 0 || denominator <= 0 {
        panic!("invalid arithmetic");
    }
    left.checked_mul(right)
        .unwrap_or_else(|| panic!("amount overflow"))
        / denominator
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{LiquidityVault, LiquidityVaultArgs, LiquidityVaultClient};
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn setup() -> (
        Env,
        LiquidityVaultClient<'static>,
        StellarAssetClient<'static>,
        TokenClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let operator = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin).address();
        let id = env.register(
            LiquidityVault,
            LiquidityVaultArgs::__constructor(&token_id, &operator, &operator, &8_000),
        );
        let client = LiquidityVaultClient::new(&env, &id);
        let asset_admin = StellarAssetClient::new(&env, &token_id);
        let token = TokenClient::new(&env, &token_id);
        asset_admin.mint(&alice, &10_000);
        asset_admin.mint(&bob, &10_000);
        (env, client, asset_admin, token, operator, alice, bob)
    }

    #[test]
    fn deposits_and_redeems_proportionally() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        let id = vault.address.clone();
        assert_eq!(vault.deposit(&alice, &1_000, &1_000), 1_000);
        asset_admin.mint(&id, &200);
        assert_eq!(vault.deposit(&bob, &600, &500), 500);
        assert_eq!(vault.total_assets(), 1_800);
        assert_eq!(vault.total_shares(), 1_500);
        assert_eq!(vault.equity(&alice), 1_200);
        assert_eq!(vault.equity(&bob), 600);
        assert_eq!(vault.withdraw(&bob, &500, &600), 600);
        assert_eq!(vault.withdraw(&alice, &1_000, &1_200), 1_200);
        assert_eq!(vault.total_assets(), 0);
        assert_eq!(token.balance(&id), 0);
        assert_eq!(vault.deposited(&alice), 1_000);
        assert_eq!(vault.withdrawn(&alice), 1_200);
    }

    #[test]
    fn pause_blocks_deposits_but_not_exits() {
        let (_, vault, _, _, _, alice, _) = setup();
        assert!(vault.paused());
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.set_paused(&true);
        assert!(vault.try_deposit(&alice, &100, &100).is_err());
        assert_eq!(vault.withdraw(&alice, &1_000, &1_000), 1_000);
    }

    #[test]
    fn rejects_zero_share_deposit_and_overdraw() {
        let (_, vault, asset_admin, _, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        asset_admin.mint(&vault.address, &9_000);
        assert!(vault.try_deposit(&bob, &1, &0).is_err());
        assert!(vault.try_withdraw(&bob, &1, &0).is_err());
    }

    #[test]
    fn losses_reduce_equity_without_changing_share_ownership() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.deposit(&bob, &1_000, &1_000);
        asset_admin.burn(&vault.address, &400);
        assert_eq!(vault.equity(&alice), 800);
        assert_eq!(vault.equity(&bob), 800);
        assert_eq!(vault.withdraw(&alice, &1_000, &800), 800);
        assert_eq!(token.balance(&vault.address), 800);
        assert_eq!(vault.withdraw(&bob, &1_000, &800), 800);
    }

    #[test]
    fn operator_cannot_take_lp_assets() {
        let (_, vault, asset_admin, token, operator, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        assert!(vault.try_recover_unowned(&operator).is_err());
        assert!(vault.try_withdraw(&operator, &1_000, &0).is_err());
        assert_eq!(token.balance(&vault.address), 1_000);
        vault.withdraw(&alice, &1_000, &1_000);
        asset_admin.mint(&vault.address, &10);
        assert_eq!(vault.recover_unowned(&operator), 10);
    }

    #[test]
    fn enforces_deposit_and_withdrawal_minimums() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        asset_admin.mint(&vault.address, &100);
        assert!(vault.try_deposit(&bob, &110, &101).is_err());
        assert_eq!(token.balance(&bob), 10_000);
        assert_eq!(vault.deposit(&bob, &110, &100), 100);
        assert!(vault.try_withdraw(&bob, &100, &111).is_err());
        assert_eq!(vault.shares(&bob), 100);
        assert_eq!(vault.withdraw(&bob, &100, &110), 110);
    }

    #[test]
    fn allocation_and_profit_are_reconciled_before_withdrawal() {
        let (_, vault, asset_admin, token, operator, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.deposit(&bob, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&1_500);
        assert_eq!(token.balance(&operator), 1_500);
        assert_eq!(vault.liquid_assets(), 500);
        assert_eq!(vault.deployed_principal(), 1_500);
        assert_eq!(vault.total_assets(), 2_000);
        assert!(vault.try_equity(&alice).is_err());
        assert!(vault.try_withdraw(&alice, &1_000, &0).is_err());
        assert!(vault.try_set_paused(&false).is_err());
        vault.request_withdraw(&alice, &1_000);
        assert_eq!(vault.pending_shares(&alice), 1_000);
        assert_eq!(vault.available_shares(&alice), 0);
        assert!(vault.try_claim_withdrawal(&alice, &0).is_err());
        asset_admin.mint(&operator, &300);
        vault.settle(&1_500, &1_800);
        assert_eq!(vault.deployed_principal(), 0);
        assert_eq!(vault.total_assets(), 2_300);
        assert_eq!(vault.claim_withdrawal(&alice, &1_150), 1_150);
        assert_eq!(vault.withdraw(&bob, &1_000, &1_150), 1_150);
        assert_eq!(vault.total_shares(), 0);
    }

    #[test]
    fn loss_is_shared_and_requests_can_be_cancelled() {
        let (_, vault, _, _, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.deposit(&bob, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&1_000);
        vault.request_withdraw(&alice, &800);
        vault.cancel_withdraw_request(&alice, &300);
        assert_eq!(vault.pending_shares(&alice), 500);
        assert!(vault.try_withdraw(&alice, &600, &0).is_err());
        vault.settle(&1_000, &700);
        assert_eq!(vault.total_assets(), 1_700);
        assert_eq!(vault.claim_withdrawal(&alice, &425), 425);
        assert_eq!(vault.withdraw(&bob, &1_000, &850), 850);
        assert_eq!(vault.withdraw(&alice, &500, &425), 425);
    }

    #[test]
    fn allocation_is_capped_and_closed_to_new_deposits() {
        let (_, vault, _, token, operator, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        assert!(vault.try_allocate(&100).is_err());
        vault.set_paused(&true);
        assert!(vault.try_allocate(&801).is_err());
        vault.allocate(&500);
        vault.allocate(&300);
        assert!(vault.try_allocate(&1).is_err());
        assert!(vault.try_deposit(&bob, &100, &0).is_err());
        assert!(vault.try_withdraw(&alice, &1_000, &0).is_err());
        assert_eq!(token.balance(&operator), 800);
        vault.settle(&500, &500);
        assert_eq!(vault.deployed_principal(), 300);
        vault.record_loss(&300);
        assert_eq!(vault.total_assets(), 700);
        assert_eq!(vault.withdraw(&alice, &1_000, &700), 700);
    }

    #[test]
    fn invalid_settlement_does_not_release_deployed_principal() {
        let (_, vault, _, _, _, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&800);
        assert!(vault.try_settle(&801, &800).is_err());
        assert!(vault.try_settle(&800, &0).is_err());
        assert!(vault.try_record_loss(&801).is_err());
        assert_eq!(vault.deployed_principal(), 800);
        assert!(vault.try_recover_unowned(&alice).is_err());
    }

    #[test]
    fn total_loss_can_clear_shares_without_a_false_payout() {
        let (_, vault, asset_admin, _, _, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&800);
        asset_admin.burn(&vault.address, &200);
        vault.record_loss(&800);
        assert_eq!(vault.withdraw(&alice, &1_000, &0), 0);
        assert_eq!(vault.total_shares(), 0);
    }

    #[test]
    fn allocation_limit_cannot_exceed_hard_cap() {
        let (_, vault, _, _, _, alice, _) = setup();
        assert!(vault.try_set_allocation_limit(&8_001).is_err());
        vault.set_allocation_limit(&5_000);
        assert_eq!(vault.allocation_limit_bps(), 5_000);
        vault.set_paused(&false);
        vault.deposit(&alice, &1_000, &1_000);
        vault.set_paused(&true);
        assert!(vault.try_allocate(&501).is_err());
    }
}
