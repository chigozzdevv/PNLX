#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token::Client as TokenClient, Address, BytesN, Env, Vec,
};

const MAX_ALLOCATION_BPS: u32 = 8_000;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_TARGET: u32 = 1_000_000;

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Asset,
    Operator,
    UpgradeAuthority,
    Maker,
    Paused,
    AllocationLimitBps,
    DeployedPrincipal,
    TotalShares,
    Shares(Address),
    PendingShares(Address),
    Deposited(Address),
    Withdrawn(Address),
    CurrentSeries,
    OtherSeriesLiquid,
    OtherSeriesPrincipal,
    OtherSeriesShares,
    SeriesLiquid(u32),
    SeriesPrincipal(u32),
    SeriesSupply(u32),
    SeriesShares(u32, Address),
    SeriesPendingShares(u32, Address),
    OwnerSeries(Address),
}

#[derive(Clone)]
#[contracttype]
pub struct SeriesPosition {
    pub series: u32,
    pub shares: i128,
    pub pending_shares: i128,
    pub assets_at_cost: i128,
    pub deployed_principal: i128,
    pub series_assets: i128,
    pub series_total_shares: i128,
}

#[contract]
pub struct LiquidityVault;

#[contractimpl]
impl LiquidityVault {
    pub fn set_upgrade_authority(env: Env, authority: Address) {
        let operator = Self::operator(env.clone());
        operator.require_auth();
        if authority == operator
            || env.storage().instance().has(&DataKey::UpgradeAuthority)
            || Self::total_shares(env.clone()) != 0
            || Self::deployed_principal(env.clone()) != 0
            || Self::liquid_assets(env.clone()) != 0
        {
            panic!("invalid upgrade authority");
        }
        env.storage()
            .instance()
            .set(&DataKey::UpgradeAuthority, &authority);
        extend_instance(&env);
    }

    pub fn rotate_upgrade_authority(env: Env, authority: Address) {
        Self::upgrade_authority(env.clone()).require_auth();
        if authority == Self::operator(env.clone()) {
            panic!("upgrade authority must differ from operator");
        }
        env.storage()
            .instance()
            .set(&DataKey::UpgradeAuthority, &authority);
        extend_instance(&env);
    }

    pub fn upgrade_authority(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeAuthority)
            .unwrap_or_else(|| panic!("upgrade authority not configured"))
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::upgrade_authority(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

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
        env.storage().instance().set(&DataKey::Paused, &paused);
        extend_instance(&env);
    }

    pub fn liquid_assets(env: Env) -> i128 {
        TokenClient::new(&env, &Self::asset(env.clone())).balance(&env.current_contract_address())
    }

    pub fn deployed_principal(env: Env) -> i128 {
        Self::asset(env.clone());
        checked_add(
            legacy_principal(&env),
            instance_amount(&env, DataKey::OtherSeriesPrincipal),
        )
    }

    pub fn current_series(env: Env) -> u32 {
        Self::asset(env.clone());
        env.storage()
            .instance()
            .get(&DataKey::CurrentSeries)
            .unwrap_or(0)
    }

    pub fn deposit_series(env: Env) -> u32 {
        let current = Self::current_series(env.clone());
        if Self::series_principal(env, current) == 0 {
            current
        } else {
            current
                .checked_add(1)
                .unwrap_or_else(|| panic!("series overflow"))
        }
    }

    pub fn series_liquid(env: Env, series: u32) -> i128 {
        check_series(&env, series);
        if series == 0 {
            checked_sub(
                Self::liquid_assets(env.clone()),
                instance_amount(&env, DataKey::OtherSeriesLiquid),
            )
        } else {
            instance_amount(&env, DataKey::SeriesLiquid(series))
        }
    }

    pub fn series_principal(env: Env, series: u32) -> i128 {
        check_series(&env, series);
        if series == 0 {
            legacy_principal(&env)
        } else {
            instance_amount(&env, DataKey::SeriesPrincipal(series))
        }
    }

    pub fn series_assets(env: Env, series: u32) -> i128 {
        checked_add(
            Self::series_liquid(env.clone(), series),
            Self::series_principal(env, series),
        )
    }

    pub fn series_total_shares(env: Env, series: u32) -> i128 {
        check_series(&env, series);
        if series == 0 {
            legacy_supply(&env)
        } else {
            instance_amount(&env, DataKey::SeriesSupply(series))
        }
    }

    pub fn series_shares(env: Env, series: u32, owner: Address) -> i128 {
        check_series(&env, series);
        owner_amount(&env, series_share_key(series, owner))
    }

    pub fn series_pending_shares(env: Env, series: u32, owner: Address) -> i128 {
        check_series(&env, series);
        owner_amount(&env, series_pending_key(series, owner))
    }

    pub fn owner_series(env: Env, owner: Address) -> Vec<u32> {
        Self::asset(env.clone());
        let mut result = Vec::new(&env);
        if owner_amount(&env, DataKey::Shares(owner.clone())) > 0
            || owner_amount(&env, DataKey::PendingShares(owner.clone())) > 0
        {
            result.push_back(0);
        }
        let known: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerSeries(owner.clone()))
            .unwrap_or(Vec::new(&env));
        for series in known.iter() {
            if owner_amount(&env, DataKey::SeriesShares(series, owner.clone())) > 0
                || owner_amount(&env, DataKey::SeriesPendingShares(series, owner.clone())) > 0
            {
                result.push_back(series);
            }
        }
        result
    }

    pub fn series_position(env: Env, series: u32, owner: Address) -> SeriesPosition {
        let shares = Self::series_shares(env.clone(), series, owner.clone());
        let supply = Self::series_total_shares(env.clone(), series);
        let assets = Self::series_assets(env.clone(), series);
        SeriesPosition {
            series,
            shares,
            pending_shares: Self::series_pending_shares(env.clone(), series, owner),
            assets_at_cost: if shares == 0 || supply == 0 {
                0
            } else {
                mul_div_floor(shares, assets, supply)
            },
            deployed_principal: Self::series_principal(env, series),
            series_assets: assets,
            series_total_shares: supply,
        }
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

    pub fn allocate(env: Env, series: u32, amount: i128) {
        Self::operator(env.clone()).require_auth();
        if series != Self::current_series(env.clone())
            || amount <= 0
            || Self::series_total_shares(env.clone(), series) == 0
        {
            panic!("allocation unavailable");
        }
        let deployed = Self::series_principal(env.clone(), series);
        if deployed != 0 {
            panic!("series allocation outstanding");
        }
        let next = checked_add(deployed, amount);
        let cap = mul_div_floor(
            Self::total_assets(env.clone()),
            Self::allocation_limit_bps(env.clone()) as i128,
            10_000,
        );
        let series_cap = mul_div_floor(
            Self::series_assets(env.clone(), series),
            Self::allocation_limit_bps(env.clone()) as i128,
            10_000,
        );
        if checked_add(Self::deployed_principal(env.clone()), amount) > cap
            || next > series_cap
            || amount > Self::series_liquid(env.clone(), series)
        {
            panic!("allocation exceeds limit");
        }
        TokenClient::new(&env, &Self::asset(env.clone())).transfer(
            &env.current_contract_address(),
            &Self::maker(env.clone()),
            &amount,
        );
        set_series_principal(&env, series, next);
        if series > 0 {
            set_series_liquid(
                &env,
                series,
                checked_sub(Self::series_liquid(env.clone(), series), amount),
            );
        }
        extend_instance(&env);
    }

    pub fn settle(env: Env, series: u32, principal: i128, returned: i128) {
        Self::operator(env.clone()).require_auth();
        let deployed = Self::series_principal(env.clone(), series);
        if principal <= 0 || principal > deployed || returned <= 0 {
            panic!("invalid settlement");
        }
        TokenClient::new(&env, &Self::asset(env.clone())).transfer(
            &Self::maker(env.clone()),
            &env.current_contract_address(),
            &returned,
        );
        set_series_principal(&env, series, deployed - principal);
        if series > 0 {
            set_series_liquid(
                &env,
                series,
                checked_add(Self::series_liquid(env.clone(), series), returned),
            );
        }
        extend_instance(&env);
    }

    pub fn record_loss(env: Env, series: u32, principal: i128) {
        Self::operator(env.clone()).require_auth();
        let deployed = Self::series_principal(env.clone(), series);
        if principal <= 0 || principal > deployed {
            panic!("invalid loss");
        }
        set_series_principal(&env, series, deployed - principal);
        extend_instance(&env);
    }

    pub fn total_shares(env: Env) -> i128 {
        Self::asset(env.clone());
        checked_add(
            legacy_supply(&env),
            instance_amount(&env, DataKey::OtherSeriesShares),
        )
    }

    pub fn shares(env: Env, owner: Address) -> i128 {
        let mut total = 0;
        for series in Self::owner_series(env.clone(), owner.clone()).iter() {
            total = checked_add(
                total,
                Self::series_shares(env.clone(), series, owner.clone()),
            );
        }
        total
    }

    pub fn pending_shares(env: Env, owner: Address) -> i128 {
        let mut total = 0;
        for series in Self::owner_series(env.clone(), owner.clone()).iter() {
            total = checked_add(
                total,
                Self::series_pending_shares(env.clone(), series, owner.clone()),
            );
        }
        total
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
        let mut total = 0;
        for series in Self::owner_series(env.clone(), owner.clone()).iter() {
            if Self::series_principal(env.clone(), series) != 0 {
                panic!("equity unavailable until settlement");
            }
            let shares = Self::series_shares(env.clone(), series, owner.clone());
            let supply = Self::series_total_shares(env.clone(), series);
            if supply > 0 {
                total = checked_add(
                    total,
                    mul_div_floor(shares, Self::series_assets(env.clone(), series), supply),
                );
            }
        }
        total
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

    pub fn deposit(env: Env, from: Address, series: u32, amount: i128, min_shares: i128) -> i128 {
        from.require_auth();
        if Self::paused(env.clone()) || series != Self::deposit_series(env.clone()) {
            panic!("vault paused");
        }
        if amount <= 0 || min_shares < 0 {
            panic!("invalid amount");
        }

        let fresh = series > Self::current_series(env.clone());
        let assets = if fresh {
            0
        } else {
            Self::series_assets(env.clone(), series)
        };
        let supply = if fresh {
            0
        } else {
            Self::series_total_shares(env.clone(), series)
        };
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
        if fresh {
            env.storage()
                .instance()
                .set(&DataKey::CurrentSeries, &series);
        }
        let owner_shares = Self::series_shares(env.clone(), series, from.clone());
        let prior_deposits = Self::deposited(env.clone(), from.clone());
        env.storage().persistent().set(
            &series_share_key(series, from.clone()),
            &checked_add(owner_shares, minted),
        );
        env.storage().persistent().set(
            &DataKey::Deposited(from.clone()),
            &checked_add(prior_deposits, amount),
        );
        set_series_supply(&env, series, checked_add(supply, minted));
        if series > 0 {
            set_series_liquid(
                &env,
                series,
                checked_add(Self::series_liquid(env.clone(), series), amount),
            );
            let key = DataKey::OwnerSeries(from.clone());
            let mut known: Vec<u32> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or(Vec::new(&env));
            if !known.iter().any(|item| item == series) {
                known.push_back(series);
            }
            env.storage().persistent().set(&key, &known);
        }
        extend_instance(&env);
        extend_owner(&env, &from);
        minted
    }

    pub fn withdraw(env: Env, owner: Address, series: u32, shares: i128, min_assets: i128) -> i128 {
        owner.require_auth();
        if shares
            > Self::series_shares(env.clone(), series, owner.clone())
                - Self::series_pending_shares(env.clone(), series, owner.clone())
        {
            panic!("shares requested for withdrawal");
        }
        let amount = redeem(&env, &owner, series, shares, min_assets);
        prune_owner_series(&env, &owner, series);
        amount
    }

    pub fn request_withdraw(env: Env, owner: Address, series: u32, shares: i128) {
        owner.require_auth();
        let available = Self::series_shares(env.clone(), series, owner.clone())
            - Self::series_pending_shares(env.clone(), series, owner.clone());
        if shares <= 0 || shares > available {
            panic!("insufficient shares");
        }
        let pending = Self::series_pending_shares(env.clone(), series, owner.clone());
        env.storage().persistent().set(
            &series_pending_key(series, owner.clone()),
            &checked_add(pending, shares),
        );
        extend_instance(&env);
        extend_owner(&env, &owner);
    }

    pub fn cancel_withdraw_request(env: Env, owner: Address, series: u32, shares: i128) {
        owner.require_auth();
        let pending = Self::series_pending_shares(env.clone(), series, owner.clone());
        if shares <= 0 || shares > pending {
            panic!("insufficient pending shares");
        }
        env.storage().persistent().set(
            &series_pending_key(series, owner.clone()),
            &(pending - shares),
        );
        extend_instance(&env);
        extend_owner(&env, &owner);
    }

    pub fn claim_withdrawal(env: Env, owner: Address, series: u32, min_assets: i128) -> i128 {
        owner.require_auth();
        let shares = Self::series_pending_shares(env.clone(), series, owner.clone());
        let amount = redeem(&env, &owner, series, shares, min_assets);
        env.storage()
            .persistent()
            .set(&series_pending_key(series, owner.clone()), &0_i128);
        prune_owner_series(&env, &owner, series);
        extend_instance(&env);
        extend_owner(&env, &owner);
        amount
    }
}

fn redeem(env: &Env, owner: &Address, series: u32, shares: i128, min_assets: i128) -> i128 {
    if LiquidityVault::series_principal(env.clone(), series) != 0 {
        panic!("allocation outstanding");
    }
    if shares <= 0 || min_assets < 0 {
        panic!("invalid amount");
    }
    let balance = LiquidityVault::series_shares(env.clone(), series, owner.clone());
    if shares > balance {
        panic!("insufficient shares");
    }
    let supply = LiquidityVault::series_total_shares(env.clone(), series);
    let assets = LiquidityVault::series_liquid(env.clone(), series);
    let amount = if shares == supply {
        assets
    } else {
        mul_div_floor(shares, assets, supply)
    };
    if (amount == 0 && assets > 0) || amount < min_assets {
        panic!("insufficient assets");
    }

    env.storage().persistent().set(
        &series_share_key(series, owner.clone()),
        &(balance - shares),
    );
    set_series_supply(env, series, supply - shares);
    if series > 0 {
        set_series_liquid(env, series, checked_sub(assets, amount));
    }
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

fn check_series(env: &Env, series: u32) {
    if series > LiquidityVault::current_series(env.clone()) {
        panic!("unknown series");
    }
}

fn instance_amount(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn owner_amount(env: &Env, key: DataKey) -> i128 {
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn legacy_principal(env: &Env) -> i128 {
    instance_amount(env, DataKey::DeployedPrincipal)
}
fn legacy_supply(env: &Env) -> i128 {
    instance_amount(env, DataKey::TotalShares)
}

fn series_share_key(series: u32, owner: Address) -> DataKey {
    if series == 0 {
        DataKey::Shares(owner)
    } else {
        DataKey::SeriesShares(series, owner)
    }
}

fn series_pending_key(series: u32, owner: Address) -> DataKey {
    if series == 0 {
        DataKey::PendingShares(owner)
    } else {
        DataKey::SeriesPendingShares(series, owner)
    }
}

fn set_series_liquid(env: &Env, series: u32, value: i128) {
    if series == 0 || value < 0 {
        panic!("invalid series liquid");
    }
    let key = DataKey::SeriesLiquid(series);
    adjust_other_total(
        env,
        DataKey::OtherSeriesLiquid,
        instance_amount(env, key.clone()),
        value,
    );
    env.storage().instance().set(&key, &value);
}

fn set_series_principal(env: &Env, series: u32, value: i128) {
    if value < 0 {
        panic!("invalid series principal");
    }
    if series == 0 {
        env.storage()
            .instance()
            .set(&DataKey::DeployedPrincipal, &value);
    } else {
        let key = DataKey::SeriesPrincipal(series);
        adjust_other_total(
            env,
            DataKey::OtherSeriesPrincipal,
            instance_amount(env, key.clone()),
            value,
        );
        env.storage().instance().set(&key, &value);
    }
}

fn set_series_supply(env: &Env, series: u32, value: i128) {
    if value < 0 {
        panic!("invalid series supply");
    }
    if series == 0 {
        env.storage().instance().set(&DataKey::TotalShares, &value);
    } else {
        let key = DataKey::SeriesSupply(series);
        adjust_other_total(
            env,
            DataKey::OtherSeriesShares,
            instance_amount(env, key.clone()),
            value,
        );
        env.storage().instance().set(&key, &value);
    }
}

fn adjust_other_total(env: &Env, key: DataKey, old: i128, new: i128) {
    let total = instance_amount(env, key.clone());
    let next = if new >= old {
        checked_add(total, new - old)
    } else {
        checked_sub(total, old - new)
    };
    env.storage().instance().set(&key, &next);
}

fn prune_owner_series(env: &Env, owner: &Address, series: u32) {
    if series == 0
        || owner_amount(env, series_share_key(series, owner.clone())) != 0
        || owner_amount(env, series_pending_key(series, owner.clone())) != 0
    {
        return;
    }
    let key = DataKey::OwnerSeries(owner.clone());
    let known: Vec<u32> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env));
    let mut remaining = Vec::new(env);
    for id in known.iter() {
        if id != series {
            remaining.push_back(id);
        }
    }
    if remaining.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &remaining);
    }
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
    let index = DataKey::OwnerSeries(owner.clone());
    if let Some(series_ids) = env.storage().persistent().get::<_, Vec<u32>>(&index) {
        env.storage()
            .persistent()
            .extend_ttl(&index, TTL_THRESHOLD, TTL_TARGET);
        for series in series_ids.iter() {
            for key in [
                DataKey::SeriesShares(series, owner.clone()),
                DataKey::SeriesPendingShares(series, owner.clone()),
            ] {
                if env.storage().persistent().has(&key) {
                    env.storage()
                        .persistent()
                        .extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
                }
            }
        }
    }
}

fn checked_add(left: i128, right: i128) -> i128 {
    left.checked_add(right)
        .unwrap_or_else(|| panic!("amount overflow"))
}

fn checked_sub(left: i128, right: i128) -> i128 {
    left.checked_sub(right)
        .filter(|value| *value >= 0)
        .unwrap_or_else(|| panic!("amount underflow"))
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
    fn upgrade_authority_is_set_before_funding_and_cannot_be_the_operator() {
        let (env, vault, _, _, operator, alice, _) = setup();
        let upgrade = Address::generate(&env);
        assert!(vault.try_upgrade_authority().is_err());
        assert!(vault.try_set_upgrade_authority(&operator).is_err());
        vault.set_upgrade_authority(&upgrade);
        assert_eq!(vault.upgrade_authority(), upgrade);
        assert!(vault
            .try_set_upgrade_authority(&Address::generate(&env))
            .is_err());
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        assert!(vault
            .try_set_upgrade_authority(&Address::generate(&env))
            .is_err());
        let replacement = Address::generate(&env);
        vault.rotate_upgrade_authority(&replacement);
        assert_eq!(vault.upgrade_authority(), replacement);
    }

    #[test]
    fn deposits_and_redeems_proportionally() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        let id = vault.address.clone();
        assert_eq!(vault.deposit(&alice, &0, &1_000, &1_000), 1_000);
        asset_admin.mint(&id, &200);
        assert_eq!(vault.deposit(&bob, &0, &600, &500), 500);
        assert_eq!(vault.total_assets(), 1_800);
        assert_eq!(vault.total_shares(), 1_500);
        assert_eq!(vault.equity(&alice), 1_200);
        assert_eq!(vault.equity(&bob), 600);
        assert_eq!(vault.withdraw(&bob, &0, &500, &600), 600);
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &1_200), 1_200);
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
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.set_paused(&true);
        assert!(vault.try_deposit(&alice, &0, &100, &100).is_err());
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &1_000), 1_000);
    }

    #[test]
    fn rejects_zero_share_deposit_and_overdraw() {
        let (_, vault, asset_admin, _, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        asset_admin.mint(&vault.address, &9_000);
        assert!(vault.try_deposit(&bob, &0, &1, &0).is_err());
        assert!(vault.try_withdraw(&bob, &0, &1, &0).is_err());
    }

    #[test]
    fn losses_reduce_equity_without_changing_share_ownership() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.deposit(&bob, &0, &1_000, &1_000);
        asset_admin.burn(&vault.address, &400);
        assert_eq!(vault.equity(&alice), 800);
        assert_eq!(vault.equity(&bob), 800);
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &800), 800);
        assert_eq!(token.balance(&vault.address), 800);
        assert_eq!(vault.withdraw(&bob, &0, &1_000, &800), 800);
    }

    #[test]
    fn operator_cannot_take_lp_assets() {
        let (_, vault, asset_admin, token, operator, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        assert!(vault.try_recover_unowned(&operator).is_err());
        assert!(vault.try_withdraw(&operator, &0, &1_000, &0).is_err());
        assert_eq!(token.balance(&vault.address), 1_000);
        vault.withdraw(&alice, &0, &1_000, &1_000);
        asset_admin.mint(&vault.address, &10);
        assert_eq!(vault.recover_unowned(&operator), 10);
    }

    #[test]
    fn enforces_deposit_and_withdrawal_minimums() {
        let (_, vault, asset_admin, token, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        asset_admin.mint(&vault.address, &100);
        assert!(vault.try_deposit(&bob, &0, &110, &101).is_err());
        assert_eq!(token.balance(&bob), 10_000);
        assert_eq!(vault.deposit(&bob, &0, &110, &100), 100);
        assert!(vault.try_withdraw(&bob, &0, &100, &111).is_err());
        assert_eq!(vault.shares(&bob), 100);
        assert_eq!(vault.withdraw(&bob, &0, &100, &110), 110);
    }

    #[test]
    fn allocation_and_profit_are_reconciled_before_withdrawal() {
        let (_, vault, asset_admin, token, operator, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.deposit(&bob, &0, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&0, &1_500);
        assert_eq!(token.balance(&operator), 1_500);
        assert_eq!(vault.liquid_assets(), 500);
        assert_eq!(vault.deployed_principal(), 1_500);
        assert_eq!(vault.total_assets(), 2_000);
        assert!(vault.try_equity(&alice).is_err());
        assert!(vault.try_withdraw(&alice, &0, &1_000, &0).is_err());
        vault.set_paused(&false);
        assert_eq!(vault.deposit_series(), 1);
        vault.request_withdraw(&alice, &0, &1_000);
        assert_eq!(vault.pending_shares(&alice), 1_000);
        assert_eq!(vault.available_shares(&alice), 0);
        assert!(vault.try_claim_withdrawal(&alice, &0, &0).is_err());
        asset_admin.mint(&operator, &300);
        vault.settle(&0, &1_500, &1_800);
        assert_eq!(vault.deployed_principal(), 0);
        assert_eq!(vault.total_assets(), 2_300);
        assert_eq!(vault.claim_withdrawal(&alice, &0, &1_150), 1_150);
        assert_eq!(vault.withdraw(&bob, &0, &1_000, &1_150), 1_150);
        assert_eq!(vault.total_shares(), 0);
    }

    #[test]
    fn loss_is_shared_and_requests_can_be_cancelled() {
        let (_, vault, _, _, _, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.deposit(&bob, &0, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&0, &1_000);
        vault.request_withdraw(&alice, &0, &800);
        vault.cancel_withdraw_request(&alice, &0, &300);
        assert_eq!(vault.pending_shares(&alice), 500);
        assert!(vault.try_withdraw(&alice, &0, &600, &0).is_err());
        vault.settle(&0, &1_000, &700);
        assert_eq!(vault.total_assets(), 1_700);
        assert_eq!(vault.claim_withdrawal(&alice, &0, &425), 425);
        assert_eq!(vault.withdraw(&bob, &0, &1_000, &850), 850);
        assert_eq!(vault.withdraw(&alice, &0, &500, &425), 425);
    }

    #[test]
    fn allocation_is_capped_and_new_deposits_use_a_new_series() {
        let (_, vault, _, token, operator, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        assert!(vault.try_allocate(&0, &801).is_err());
        vault.set_paused(&true);
        vault.allocate(&0, &800);
        assert!(vault.try_allocate(&0, &1).is_err());
        assert!(vault.try_deposit(&bob, &0, &100, &0).is_err());
        vault.set_paused(&false);
        assert_eq!(vault.deposit(&bob, &1, &100, &100), 100);
        assert_eq!(vault.series_shares(&1, &bob), 100);
        assert!(vault.try_withdraw(&alice, &0, &1_000, &0).is_err());
        assert_eq!(token.balance(&operator), 800);
        vault.settle(&0, &500, &500);
        assert_eq!(vault.deployed_principal(), 300);
        vault.record_loss(&0, &300);
        assert_eq!(vault.total_assets(), 800);
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &700), 700);
        assert_eq!(vault.withdraw(&bob, &1, &100, &100), 100);
    }

    #[test]
    fn later_supply_is_active_and_prior_trade_results_stay_with_prior_shares() {
        let (_, vault, asset_admin, token, operator, alice, bob) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.allocate(&0, &800);
        assert_eq!(vault.deposit_series(), 1);
        assert!(vault.try_deposit(&bob, &0, &500, &0).is_err());
        assert_eq!(vault.deposit(&bob, &1, &500, &500), 500);
        assert_eq!(vault.shares(&bob), 500);
        assert_eq!(vault.series_assets(&0), 1_000);
        assert_eq!(vault.series_assets(&1), 500);
        assert_eq!(vault.current_series(), 1);
        vault.allocate(&1, &400);
        assert_eq!(vault.deployed_principal(), 1_200);
        assert_eq!(vault.deposit_series(), 2);
        assert!(vault.try_deposit(&bob, &1, &100, &0).is_err());

        asset_admin.burn(&operator, &200);
        vault.settle(&0, &800, &600);
        assert_eq!(vault.series_assets(&0), 800);
        assert_eq!(vault.series_assets(&1), 500);
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &800), 800);
        assert!(vault.try_withdraw(&bob, &1, &500, &0).is_err());

        asset_admin.mint(&operator, &50);
        vault.settle(&1, &400, &450);
        assert_eq!(vault.series_assets(&1), 550);
        assert_eq!(vault.withdraw(&bob, &1, &500, &550), 550);
        assert_eq!(token.balance(&vault.address), 0);
    }

    #[test]
    fn one_lp_can_exit_new_cash_while_their_older_trade_is_open() {
        let (env, vault, _, token, _, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.allocate(&0, &800);
        vault.deposit(&alice, &1, &100, &100);
        assert_eq!(
            vault.owner_series(&alice),
            soroban_sdk::vec![&env, 0_u32, 1_u32]
        );
        assert_eq!(vault.shares(&alice), 1_100);
        assert_eq!(vault.withdraw(&alice, &1, &100, &100), 100);
        assert_eq!(vault.owner_series(&alice), soroban_sdk::vec![&env, 0_u32]);
        assert_eq!(vault.shares(&alice), 1_000);
        assert_eq!(token.balance(&vault.address), 200);
        assert!(vault.try_withdraw(&alice, &0, &1_000, &0).is_err());
    }

    #[test]
    fn invalid_settlement_does_not_release_deployed_principal() {
        let (_, vault, _, _, _, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&0, &800);
        assert!(vault.try_settle(&0, &801, &800).is_err());
        assert!(vault.try_settle(&0, &800, &0).is_err());
        assert!(vault.try_record_loss(&0, &801).is_err());
        assert_eq!(vault.deployed_principal(), 800);
        assert!(vault.try_recover_unowned(&alice).is_err());
    }

    #[test]
    fn total_loss_can_clear_shares_without_a_false_payout() {
        let (_, vault, asset_admin, _, _, alice, _) = setup();
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.set_paused(&true);
        vault.allocate(&0, &800);
        asset_admin.burn(&vault.address, &200);
        vault.record_loss(&0, &800);
        assert_eq!(vault.withdraw(&alice, &0, &1_000, &0), 0);
        assert_eq!(vault.total_shares(), 0);
    }

    #[test]
    fn allocation_limit_cannot_exceed_hard_cap() {
        let (_, vault, _, _, _, alice, _) = setup();
        assert!(vault.try_set_allocation_limit(&8_001).is_err());
        vault.set_allocation_limit(&5_000);
        assert_eq!(vault.allocation_limit_bps(), 5_000);
        vault.set_paused(&false);
        vault.deposit(&alice, &0, &1_000, &1_000);
        vault.set_paused(&true);
        assert!(vault.try_allocate(&0, &501).is_err());
    }
}
