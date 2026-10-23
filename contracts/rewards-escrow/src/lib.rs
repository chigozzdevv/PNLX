#![no_std]

use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype,
    token::Client as TokenClient, Address, BytesN, Env, Vec,
};

const REBATE: u32 = 0;
const REFERRAL: u32 = 1;
const TTL_THRESHOLD: u32 = 100_000;
const TTL_TARGET: u32 = 1_000_000;
const MAX_DROP_EPOCH_SECONDS: u64 = 30 * 24 * 60 * 60;

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Token,
    Treasury,
    UpgradeAuthority,
    FeePool,
    Liability,
    Funded,
    Paid,
    Returned,
    DropFunded,
    DropReturned,
    DropAllocated,
    DropReserved,
    DropConsumer,
    DropEpoch(BytesN<32>),
    DropBatch(BytesN<32>),
    DropNullifier(BytesN<32>),
    Credit(Address, u32),
    CreditedTotal(Address, u32),
    ClaimedTotal(Address, u32),
    Grant(BytesN<32>),
}

#[derive(Clone)]
#[contracttype]
pub struct FeePaid {
    pub insurance: i128,
    pub treasury: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct FeeDestinations {
    pub insurance: Address,
    pub treasury: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct DropEpoch {
    pub allocation_root: BytesN<32>,
    pub amount: i128,
    pub spent: i128,
    pub expires_at: u64,
    pub released: bool,
}

#[contractclient(name = "FeePoolClient")]
pub trait FeePool {
    fn fee_paid(env: Env, token: Address) -> FeePaid;
    fn fee_destinations(env: Env) -> Option<FeeDestinations>;
}

#[contractevent]
pub struct RewardFunded {
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
pub struct RewardCredited {
    #[topic]
    pub owner: Address,
    #[topic]
    pub kind: u32,
    pub grant_id: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
pub struct RewardClaimed {
    #[topic]
    pub owner: Address,
    #[topic]
    pub kind: u32,
    pub amount: i128,
}

#[contract]
pub struct RewardsEscrow;

#[contractimpl]
impl RewardsEscrow {
    pub fn __constructor(
        env: Env,
        token: Address,
        treasury: Address,
        upgrade_authority: Address,
        fee_pool: Address,
    ) {
        treasury.require_auth();
        if treasury == upgrade_authority || token == env.current_contract_address() {
            panic!("invalid rewards configuration");
        }
        let destinations = FeePoolClient::new(&env, &fee_pool)
            .fee_destinations()
            .expect("fee destinations not configured");
        if destinations.treasury != treasury {
            panic!("fee treasury mismatch");
        }
        let store = env.storage().instance();
        store.set(&DataKey::Token, &token);
        store.set(&DataKey::Treasury, &treasury);
        store.set(&DataKey::UpgradeAuthority, &upgrade_authority);
        store.set(&DataKey::FeePool, &fee_pool);
        store.set(&DataKey::Liability, &0_i128);
        store.set(&DataKey::Funded, &0_i128);
        store.set(&DataKey::Paid, &0_i128);
        store.set(&DataKey::Returned, &0_i128);
        store.set(&DataKey::DropFunded, &0_i128);
        store.set(&DataKey::DropReturned, &0_i128);
        store.set(&DataKey::DropAllocated, &0_i128);
        store.set(&DataKey::DropReserved, &0_i128);
        extend_instance(&env);
    }

    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .expect("not initialized")
    }

    pub fn treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .expect("not initialized")
    }

    pub fn fee_pool(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::FeePool)
            .expect("not initialized")
    }

    pub fn drop_funding_limit(env: Env) -> i128 {
        paid_treasury(&env) / 10
    }

    pub fn upgrade_authority(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeAuthority)
            .expect("not initialized")
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        Self::upgrade_authority(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    pub fn liability(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Liability)
            .expect("not initialized")
    }

    pub fn funded(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Funded)
            .expect("not initialized")
    }

    pub fn paid(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Paid)
            .expect("not initialized")
    }

    pub fn returned(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Returned)
            .expect("not initialized")
    }

    pub fn drop_funded(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DropFunded)
            .expect("not initialized")
    }

    pub fn drop_returned(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DropReturned)
            .expect("not initialized")
    }

    pub fn drop_allocated(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DropAllocated)
            .unwrap_or(0)
    }

    pub fn drop_reserved(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DropReserved)
            .unwrap_or(0)
    }

    pub fn drop_epoch(env: Env, epoch_id: BytesN<32>) -> Option<DropEpoch> {
        env.storage()
            .persistent()
            .get(&DataKey::DropEpoch(epoch_id))
    }

    pub fn drop_consumer(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::DropConsumer)
    }

    pub fn configure_drop_consumer(env: Env, consumer: Address) {
        Self::treasury(env.clone()).require_auth();
        let store = env.storage().instance();
        if store.has(&DataKey::DropConsumer)
            || consumer == env.current_contract_address()
            || consumer == Self::treasury(env.clone())
        {
            panic!("invalid credit drop consumer");
        }
        store.set(&DataKey::DropConsumer, &consumer);
        extend_instance(&env);
    }

    pub fn issue_drop_epoch(
        env: Env,
        epoch_id: BytesN<32>,
        allocation_root: BytesN<32>,
        amount: i128,
        expires_at: u64,
    ) {
        Self::treasury(env.clone()).require_auth();
        if epoch_id == BytesN::from_array(&env, &[0; 32])
            || allocation_root == BytesN::from_array(&env, &[0; 32])
            || amount <= 0
            || expires_at <= env.ledger().timestamp()
            || expires_at
                > env
                    .ledger()
                    .timestamp()
                    .saturating_add(MAX_DROP_EPOCH_SECONDS)
            || Self::drop_available(env.clone()) < amount
        {
            panic!("invalid credit drop epoch");
        }
        let key = DataKey::DropEpoch(epoch_id);
        let store = env.storage().persistent();
        if store.has(&key) {
            panic!("credit drop epoch already issued");
        }
        store.set(
            &key,
            &DropEpoch {
                allocation_root,
                amount,
                spent: 0,
                expires_at,
                released: false,
            },
        );
        store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        add_instance_amount(&env, DataKey::DropReserved, amount);
        extend_instance(&env);
    }

    pub fn spend_drop_batch(
        env: Env,
        epoch_id: BytesN<32>,
        batch_id: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,
        amount: i128,
    ) {
        let consumer: Address = env
            .storage()
            .instance()
            .get(&DataKey::DropConsumer)
            .expect("credit drop consumer not configured");
        consumer.require_auth();
        if amount <= 0
            || nullifiers.is_empty()
            || nullifiers.len() > 8
            || batch_id == BytesN::from_array(&env, &[0; 32])
            || env
                .storage()
                .persistent()
                .has(&DataKey::DropBatch(batch_id.clone()))
        {
            panic!("invalid credit drop batch");
        }
        let key = DataKey::DropEpoch(epoch_id);
        let store = env.storage().persistent();
        let mut epoch: DropEpoch = store.get(&key).expect("unknown credit drop epoch");
        if epoch.released
            || env.ledger().timestamp() >= epoch.expires_at
            || epoch.amount.checked_sub(epoch.spent).unwrap_or(-1) < amount
        {
            panic!("credit drop budget unavailable");
        }
        for nullifier in nullifiers.iter() {
            if nullifier == BytesN::from_array(&env, &[0; 32])
                || store.has(&DataKey::DropNullifier(nullifier.clone()))
            {
                panic!("credit drop already spent");
            }
            store.set(&DataKey::DropNullifier(nullifier.clone()), &true);
            store.extend_ttl(
                &DataKey::DropNullifier(nullifier),
                TTL_THRESHOLD,
                TTL_TARGET,
            );
        }
        epoch.spent = epoch
            .spent
            .checked_add(amount)
            .expect("credit drop spent overflow");
        store.set(&key, &epoch);
        store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        store.set(&DataKey::DropBatch(batch_id.clone()), &true);
        store.extend_ttl(&DataKey::DropBatch(batch_id), TTL_THRESHOLD, TTL_TARGET);
        add_instance_amount(&env, DataKey::DropReserved, -amount);
        add_instance_amount(&env, DataKey::DropAllocated, amount);
        TokenClient::new(&env, &Self::token(env.clone())).transfer(
            &env.current_contract_address(),
            &Self::fee_pool(env.clone()),
            &amount,
        );
        extend_instance(&env);
    }

    pub fn expire_drop_epoch(env: Env, epoch_id: BytesN<32>) {
        let key = DataKey::DropEpoch(epoch_id);
        let store = env.storage().persistent();
        let mut epoch: DropEpoch = store.get(&key).expect("unknown credit drop epoch");
        if epoch.released || env.ledger().timestamp() < epoch.expires_at {
            panic!("credit drop epoch has not expired");
        }
        let unused = epoch
            .amount
            .checked_sub(epoch.spent)
            .expect("invalid credit drop epoch");
        epoch.released = true;
        store.set(&key, &epoch);
        store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        add_instance_amount(&env, DataKey::DropReserved, -unused);
        extend_instance(&env);
    }

    pub fn drop_available(env: Env) -> i128 {
        let amount = Self::drop_funded(env.clone())
            .checked_sub(Self::drop_returned(env.clone()))
            .and_then(|value| value.checked_sub(Self::drop_allocated(env.clone())))
            .and_then(|value| value.checked_sub(Self::drop_reserved(env.clone())))
            .expect("invalid credit drop accounting");
        check_balance(&env);
        amount
    }

    pub fn available(env: Env) -> i128 {
        let recognized = Self::funded(env.clone())
            .checked_sub(Self::paid(env.clone()))
            .and_then(|amount| amount.checked_sub(Self::returned(env.clone())))
            .expect("invalid rewards accounting");
        check_balance(&env);
        recognized
            .checked_sub(Self::liability(env))
            .expect("rewards escrow is underfunded")
    }

    pub fn claimable(env: Env, owner: Address, kind: u32) -> i128 {
        assert_kind(kind);
        let key = DataKey::Credit(owner, kind);
        let store = env.storage().persistent();
        let amount = store.get(&key).unwrap_or(0);
        if amount > 0 {
            store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
        amount
    }

    pub fn credited_total(env: Env, owner: Address, kind: u32) -> i128 {
        assert_kind(kind);
        let key = DataKey::CreditedTotal(owner, kind);
        let store = env.storage().persistent();
        let amount = store.get(&key).unwrap_or(0);
        if amount > 0 {
            store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
        amount
    }

    pub fn claimed_total(env: Env, owner: Address, kind: u32) -> i128 {
        assert_kind(kind);
        let key = DataKey::ClaimedTotal(owner, kind);
        let store = env.storage().persistent();
        let amount = store.get(&key).unwrap_or(0);
        if amount > 0 {
            store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
        amount
    }

    pub fn credited(env: Env, grant_id: BytesN<32>) -> bool {
        let key = DataKey::Grant(grant_id);
        let store = env.storage().persistent();
        let exists = store.has(&key);
        if exists {
            store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
        exists
    }

    pub fn keepalive_credit(env: Env, owner: Address, kind: u32) {
        assert_kind(kind);
        for key in [
            DataKey::Credit(owner.clone(), kind),
            DataKey::CreditedTotal(owner.clone(), kind),
            DataKey::ClaimedTotal(owner.clone(), kind),
        ] {
            let store = env.storage().persistent();
            if store.has(&key) {
                store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
            }
        }
        extend_instance(&env);
    }

    pub fn keepalive_grant(env: Env, grant_id: BytesN<32>) {
        let key = DataKey::Grant(grant_id);
        let store = env.storage().persistent();
        if store.has(&key) {
            store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
        }
        extend_instance(&env);
    }

    pub fn keepalive_instance(env: Env) {
        Self::token(env.clone());
        extend_instance(&env);
    }

    pub fn fund(env: Env, amount: i128) {
        if amount <= 0 {
            panic!("invalid funding amount");
        }
        Self::treasury(env.clone()).require_auth();
        fund_after_auth(&env, amount);
    }

    pub fn fund_and_credit(
        env: Env,
        grant_id: BytesN<32>,
        owner: Address,
        kind: u32,
        funding_amount: i128,
        reward_amount: i128,
    ) {
        if funding_amount <= 0 || reward_amount <= 0 {
            panic!("invalid reward funding");
        }
        assert_kind(kind);
        Self::treasury(env.clone()).require_auth();
        if Self::credited(env.clone(), grant_id.clone()) {
            panic!("reward already credited");
        }
        fund_after_auth(&env, funding_amount);
        credit_after_auth(&env, grant_id, owner, kind, reward_amount);
    }

    pub fn fund_drop(env: Env, amount: i128) {
        if amount <= 0 {
            panic!("invalid credit drop funding");
        }
        let treasury = Self::treasury(env.clone());
        treasury.require_auth();
        check_funding_cap(&env, 0, amount);
        TokenClient::new(&env, &Self::token(env.clone())).transfer(
            &treasury,
            &env.current_contract_address(),
            &amount,
        );
        add_instance_amount(&env, DataKey::DropFunded, amount);
        extend_instance(&env);
    }

    pub fn credit(env: Env, grant_id: BytesN<32>, owner: Address, kind: u32, amount: i128) {
        assert_kind(kind);
        if amount <= 0 {
            panic!("invalid reward amount");
        }
        Self::treasury(env.clone()).require_auth();
        credit_after_auth(&env, grant_id, owner, kind, amount);
    }

    pub fn claim(env: Env, owner: Address, kind: u32) -> i128 {
        owner.require_auth();
        let amount = Self::claimable(env.clone(), owner.clone(), kind);
        if amount <= 0 {
            panic!("no reward to claim");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Credit(owner.clone(), kind), &0_i128);
        add_owner_amount(&env, DataKey::ClaimedTotal(owner.clone(), kind), amount);
        add_instance_amount(&env, DataKey::Liability, -amount);
        add_instance_amount(&env, DataKey::Paid, amount);
        extend_instance(&env);
        TokenClient::new(&env, &Self::token(env.clone())).transfer(
            &env.current_contract_address(),
            &owner,
            &amount,
        );
        RewardClaimed {
            owner,
            kind,
            amount,
        }
        .publish(&env);
        amount
    }

    pub fn return_unallocated(env: Env, amount: i128) {
        if amount <= 0 || Self::available(env.clone()) < amount {
            panic!("invalid return amount");
        }
        let treasury = Self::treasury(env.clone());
        treasury.require_auth();
        TokenClient::new(&env, &Self::token(env.clone())).transfer(
            &env.current_contract_address(),
            &treasury,
            &amount,
        );
        add_instance_amount(&env, DataKey::Returned, amount);
        extend_instance(&env);
    }

    pub fn return_unallocated_drop(env: Env, amount: i128) {
        if amount <= 0 || Self::drop_available(env.clone()) < amount {
            panic!("invalid credit drop return");
        }
        let treasury = Self::treasury(env.clone());
        treasury.require_auth();
        TokenClient::new(&env, &Self::token(env.clone())).transfer(
            &env.current_contract_address(),
            &treasury,
            &amount,
        );
        add_instance_amount(&env, DataKey::DropReturned, amount);
        extend_instance(&env);
    }
}

fn fund_after_auth(env: &Env, amount: i128) {
    check_funding_cap(env, amount, 0);
    let token = RewardsEscrow::token(env.clone());
    TokenClient::new(env, &token).transfer(
        &RewardsEscrow::treasury(env.clone()),
        &env.current_contract_address(),
        &amount,
    );
    add_instance_amount(env, DataKey::Funded, amount);
    extend_instance(env);
    RewardFunded { token, amount }.publish(env);
}

fn paid_treasury(env: &Env) -> i128 {
    let pool = FeePoolClient::new(env, &RewardsEscrow::fee_pool(env.clone()));
    if pool
        .fee_destinations()
        .expect("fee destinations not configured")
        .treasury
        != RewardsEscrow::treasury(env.clone())
    {
        panic!("fee treasury mismatch");
    }
    let paid = pool.fee_paid(&RewardsEscrow::token(env.clone())).treasury;
    if paid < 0 {
        panic!("invalid paid treasury fees");
    }
    paid
}

fn check_funding_cap(env: &Env, rewards: i128, drops: i128) {
    let paid = paid_treasury(env);
    let drop_total = RewardsEscrow::drop_funded(env.clone())
        .checked_add(drops)
        .expect("credit drop funding overflow");
    let total = RewardsEscrow::funded(env.clone())
        .checked_add(rewards)
        .and_then(|value| value.checked_add(drop_total))
        .expect("rewards funding overflow");
    if drop_total > paid / 10 || total > paid {
        panic!("reward funding exceeds paid treasury fees");
    }
}

fn credit_after_auth(env: &Env, grant_id: BytesN<32>, owner: Address, kind: u32, amount: i128) {
    if RewardsEscrow::credited(env.clone(), grant_id.clone()) {
        panic!("reward already credited");
    }
    if RewardsEscrow::available(env.clone()) < amount {
        panic!("insufficient reward funding");
    }
    let key = DataKey::Credit(owner.clone(), kind);
    let store = env.storage().persistent();
    let balance: i128 = store.get(&key).unwrap_or(0);
    store.set(&key, &balance.checked_add(amount).expect("reward overflow"));
    store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
    add_owner_amount(env, DataKey::CreditedTotal(owner.clone(), kind), amount);
    let grant_key = DataKey::Grant(grant_id.clone());
    store.set(&grant_key, &true);
    store.extend_ttl(&grant_key, TTL_THRESHOLD, TTL_TARGET);
    add_instance_amount(env, DataKey::Liability, amount);
    extend_instance(env);
    RewardCredited {
        owner,
        kind,
        grant_id,
        amount,
    }
    .publish(env);
}

fn check_balance(env: &Env) {
    let rewards = RewardsEscrow::funded(env.clone())
        .checked_sub(RewardsEscrow::paid(env.clone()))
        .and_then(|value| value.checked_sub(RewardsEscrow::returned(env.clone())))
        .expect("invalid rewards accounting");
    let drops = RewardsEscrow::drop_funded(env.clone())
        .checked_sub(RewardsEscrow::drop_returned(env.clone()))
        .and_then(|value| value.checked_sub(RewardsEscrow::drop_allocated(env.clone())))
        .expect("invalid credit drop accounting");
    let recognized = rewards.checked_add(drops).expect("escrow balance overflow");
    if TokenClient::new(env, &RewardsEscrow::token(env.clone()))
        .balance(&env.current_contract_address())
        < recognized
    {
        panic!("rewards escrow is underfunded");
    }
}

fn assert_kind(kind: u32) {
    if kind != REBATE && kind != REFERRAL {
        panic!("invalid reward kind");
    }
}

fn add_instance_amount(env: &Env, key: DataKey, amount: i128) {
    let store = env.storage().instance();
    let current: i128 = store.get(&key).unwrap_or_else(|| match &key {
        // These totals did not exist before Credit Drop epochs were introduced.
        DataKey::DropAllocated | DataKey::DropReserved => 0,
        _ => panic!("not initialized"),
    });
    let next = current.checked_add(amount).expect("reward amount overflow");
    if next < 0 {
        panic!("negative reward amount");
    }
    store.set(&key, &next);
}

fn add_owner_amount(env: &Env, key: DataKey, amount: i128) {
    let store = env.storage().persistent();
    let current: i128 = store.get(&key).unwrap_or(0);
    let next = current.checked_add(amount).expect("reward amount overflow");
    store.set(&key, &next);
    store.extend_ttl(&key, TTL_THRESHOLD, TTL_TARGET);
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_TARGET);
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{
        DataKey, FeeDestinations, FeePaid, RewardsEscrow, RewardsEscrowArgs, RewardsEscrowClient,
    };
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, BytesN, Env, Vec,
    };

    #[contract]
    pub struct TestFeePool;

    #[contractimpl]
    impl TestFeePool {
        pub fn __constructor(env: Env, treasury: Address, insurance: Address, token: Address) {
            env.storage().instance().set(
                &0_u32,
                &FeeDestinations {
                    treasury,
                    insurance,
                },
            );
            env.storage().instance().set(&1_u32, &token);
            env.storage().instance().set(&2_u32, &1_000_i128);
        }
        pub fn fee_destinations(env: Env) -> Option<FeeDestinations> {
            env.storage().instance().get(&0_u32)
        }
        pub fn fee_paid(env: Env, token: Address) -> FeePaid {
            assert_eq!(
                token,
                env.storage().instance().get::<_, Address>(&1_u32).unwrap()
            );
            FeePaid {
                treasury: env.storage().instance().get(&2_u32).unwrap(),
                insurance: 100_000,
            }
        }
    }

    fn setup() -> (
        Env,
        RewardsEscrowClient<'static>,
        StellarAssetClient<'static>,
        TokenClient<'static>,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let asset_admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let owner = Address::generate(&env);
        let authority = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(asset_admin)
            .address();
        let pool = env.register(
            TestFeePool,
            TestFeePoolArgs::__constructor(&treasury, &Address::generate(&env), &token_id),
        );
        let id = env.register(
            RewardsEscrow,
            RewardsEscrowArgs::__constructor(&token_id, &treasury, &authority, &pool),
        );
        let rewards = RewardsEscrowClient::new(&env, &id);
        let admin = StellarAssetClient::new(&env, &token_id);
        let token = TokenClient::new(&env, &token_id);
        admin.mint(&treasury, &1_000);
        (env, rewards, admin, token, treasury, owner)
    }

    #[test]
    fn credits_only_funded_usdc_and_claims_once() {
        let (env, rewards, _, token, treasury, owner) = setup();
        let grant = BytesN::from_array(&env, &[1; 32]);
        assert!(rewards.try_credit(&grant, &owner, &0, &200).is_err());
        rewards.fund(&300);
        assert_eq!(token.balance(&treasury), 700);
        assert_eq!(rewards.available(), 300);
        rewards.credit(&grant, &owner, &0, &200);
        assert!(rewards.try_credit(&grant, &owner, &0, &200).is_err());
        assert!(rewards
            .try_credit(&BytesN::from_array(&env, &[2; 32]), &owner, &1, &101)
            .is_err());
        assert_eq!(rewards.claimable(&owner, &0), 200);
        assert_eq!(rewards.liability(), 200);
        assert_eq!(rewards.available(), 100);
        assert!(rewards.try_return_unallocated(&101).is_err());
        rewards.return_unallocated(&100);
        assert_eq!(token.balance(&treasury), 800);
        assert_eq!(rewards.available(), 0);
        assert_eq!(rewards.claim(&owner, &0), 200);
        assert_eq!(token.balance(&owner), 200);
        assert_eq!(rewards.paid(), 200);
        assert_eq!(rewards.liability(), 0);
        assert!(rewards.try_claim(&owner, &0).is_err());
    }

    #[test]
    fn reward_kinds_have_separate_balances() {
        let (env, rewards, _, token, _, owner) = setup();
        rewards.fund(&300);
        rewards.credit(&BytesN::from_array(&env, &[1; 32]), &owner, &0, &100);
        rewards.credit(&BytesN::from_array(&env, &[2; 32]), &owner, &1, &150);
        assert_eq!(rewards.claim(&owner, &1), 150);
        assert_eq!(rewards.claimable(&owner, &0), 100);
        assert_eq!(token.balance(&owner), 150);
        assert!(rewards
            .try_credit(&BytesN::from_array(&env, &[3; 32]), &owner, &2, &1)
            .is_err());
    }

    #[test]
    fn direct_transfers_do_not_create_a_reward_budget() {
        let (env, rewards, _, token, treasury, owner) = setup();
        token.transfer(&treasury, &rewards.address, &100);
        assert_eq!(rewards.available(), 0);
        assert!(rewards
            .try_credit(&BytesN::from_array(&env, &[4; 32]), &owner, &0, &1)
            .is_err());
    }

    #[test]
    fn credit_drop_funds_cannot_back_cash_rewards() {
        let (env, rewards, _, token, treasury, owner) = setup();
        rewards.fund_drop(&100);
        assert_eq!(rewards.drop_available(), 100);
        assert_eq!(rewards.available(), 0);
        assert!(rewards
            .try_credit(&BytesN::from_array(&env, &[7; 32]), &owner, &0, &1)
            .is_err());
        assert!(rewards.try_return_unallocated(&1).is_err());
        rewards.fund(&50);
        rewards.credit(&BytesN::from_array(&env, &[8; 32]), &owner, &0, &50);
        assert!(rewards.try_return_unallocated_drop(&101).is_err());
        rewards.return_unallocated_drop(&100);
        assert_eq!(rewards.drop_available(), 0);
        assert_eq!(rewards.claim(&owner, &0), 50);
        assert_eq!(token.balance(&treasury), 950);
    }

    #[test]
    fn funding_and_credit_are_atomic_on_duplicate_grant() {
        let (env, rewards, _, token, treasury, owner) = setup();
        let grant = BytesN::from_array(&env, &[9; 32]);
        rewards.fund_and_credit(&grant, &owner, &0, &100, &100);
        assert_eq!(token.balance(&treasury), 900);
        assert!(rewards
            .try_fund_and_credit(&grant, &owner, &0, &100, &100)
            .is_err());
        assert_eq!(token.balance(&treasury), 900);
        assert_eq!(rewards.funded(), 100);
        assert_eq!(rewards.claimable(&owner, &0), 100);
    }

    #[test]
    fn treasury_and_owner_authorization_are_required() {
        let (env, rewards, _, _, _, owner) = setup();
        rewards.fund(&100);
        rewards.credit(&BytesN::from_array(&env, &[5; 32]), &owner, &0, &50);
        env.set_auths(&[]);
        assert!(rewards.try_fund(&1).is_err());
        assert!(rewards
            .try_credit(&BytesN::from_array(&env, &[6; 32]), &owner, &0, &1)
            .is_err());
        assert!(rewards.try_claim(&owner, &0).is_err());
    }

    #[test]
    fn drop_cap_uses_paid_treasury_fees_and_survives_returns() {
        let (_, rewards, _, token, treasury, _) = setup();
        assert_eq!(rewards.drop_funding_limit(), 100);
        assert!(rewards.try_fund_drop(&101).is_err());
        assert_eq!(token.balance(&treasury), 1_000);
        rewards.fund_drop(&100);
        rewards.return_unallocated_drop(&100);
        assert!(rewards.try_fund_drop(&1).is_err());
        assert_eq!(rewards.drop_funded(), 100);
    }

    #[test]
    fn combined_funding_cannot_exceed_paid_treasury_fees() {
        let (_, rewards, admin, token, treasury, _) = setup();
        admin.mint(&treasury, &2_000);
        rewards.fund_drop(&100);
        rewards.fund(&900);
        assert!(rewards.try_fund(&1).is_err());
        rewards.return_unallocated(&900);
        assert!(rewards.try_fund(&1).is_err());
        assert_eq!(token.balance(&treasury), 2_900);
    }

    #[test]
    fn older_instance_keeps_rewards_and_can_start_using_drop_epochs() {
        let (env, rewards, _, token, _, owner) = setup();
        rewards.fund(&600);
        rewards.fund_drop(&100);
        let paid_grant = BytesN::from_array(&env, &[21; 32]);
        let outstanding_grant = BytesN::from_array(&env, &[22; 32]);
        rewards.credit(&paid_grant, &owner, &0, &200);
        assert_eq!(rewards.claim(&owner, &0), 200);
        rewards.credit(&outstanding_grant, &owner, &1, &150);
        rewards.return_unallocated(&50);
        rewards.return_unallocated_drop(&10);

        // An upgraded pre-epoch instance has every old entry but neither new total.
        env.as_contract(&rewards.address, || {
            env.storage().instance().remove(&DataKey::DropAllocated);
            env.storage().instance().remove(&DataKey::DropReserved);
        });
        assert_eq!(rewards.drop_allocated(), 0);
        assert_eq!(rewards.drop_reserved(), 0);
        assert_eq!(rewards.funded(), 600);
        assert_eq!(rewards.paid(), 200);
        assert_eq!(rewards.returned(), 50);
        assert_eq!(rewards.liability(), 150);
        assert_eq!(rewards.drop_funded(), 100);
        assert_eq!(rewards.drop_returned(), 10);
        assert_eq!(rewards.available(), 200);
        assert_eq!(rewards.drop_available(), 90);
        assert!(rewards.credited(&paid_grant));
        assert!(rewards.credited(&outstanding_grant));
        assert_eq!(rewards.claimable(&owner, &1), 150);
        assert_eq!(rewards.credited_total(&owner, &0), 200);
        assert_eq!(rewards.claimed_total(&owner, &0), 200);
        assert!(rewards.try_credit(&paid_grant, &owner, &0, &1).is_err());

        rewards.credit(&BytesN::from_array(&env, &[23; 32]), &owner, &0, &40);
        assert_eq!(rewards.claim(&owner, &1), 150);
        assert_eq!(rewards.claimable(&owner, &0), 40);
        assert_eq!(rewards.liability(), 40);
        assert_eq!(rewards.paid(), 350);
        assert_eq!(rewards.available(), 160);
        assert_eq!(token.balance(&owner), 350);

        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let epoch = BytesN::from_array(&env, &[24; 32]);
        rewards.configure_drop_consumer(&Address::generate(&env));
        rewards.issue_drop_epoch(&epoch, &BytesN::from_array(&env, &[25; 32]), &80, &1_100);
        rewards.spend_drop_batch(
            &epoch,
            &BytesN::from_array(&env, &[26; 32]),
            &Vec::from_array(&env, [BytesN::from_array(&env, &[27; 32])]),
            &30,
        );
        assert_eq!(rewards.drop_allocated(), 30);
        assert_eq!(rewards.drop_reserved(), 50);
        assert_eq!(rewards.drop_available(), 10);
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
        rewards.expire_drop_epoch(&epoch);
        rewards.return_unallocated_drop(&60);
        assert_eq!(rewards.drop_returned(), 70);
        assert_eq!(rewards.drop_allocated(), 30);
        assert_eq!(rewards.drop_reserved(), 0);
        assert_eq!(rewards.drop_available(), 0);
        assert_eq!(rewards.funded(), 600);
        assert_eq!(rewards.returned(), 50);
        assert_eq!(rewards.available(), 160);
        assert_eq!(rewards.claimable(&owner, &0), 40);
    }

    #[test]
    fn existing_nonzero_drop_totals_survive_compatible_reads_and_updates() {
        let (env, rewards, _, _, _, owner) = setup();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        rewards.fund_drop(&100);
        rewards.configure_drop_consumer(&Address::generate(&env));
        let first = BytesN::from_array(&env, &[31; 32]);
        let root = BytesN::from_array(&env, &[32; 32]);
        rewards.issue_drop_epoch(&first, &root, &80, &1_100);
        rewards.spend_drop_batch(
            &first,
            &BytesN::from_array(&env, &[33; 32]),
            &Vec::from_array(&env, [BytesN::from_array(&env, &[34; 32])]),
            &30,
        );
        rewards.fund(&100);
        rewards.credit(&BytesN::from_array(&env, &[35; 32]), &owner, &0, &50);
        assert_eq!(rewards.drop_allocated(), 30);
        assert_eq!(rewards.drop_reserved(), 50);
        assert_eq!(rewards.available(), 50);
        assert_eq!(rewards.drop_available(), 20);
        rewards.issue_drop_epoch(&BytesN::from_array(&env, &[36; 32]), &root, &10, &1_200);
        assert_eq!(rewards.drop_allocated(), 30);
        assert_eq!(rewards.drop_reserved(), 60);
        assert_eq!(rewards.drop_available(), 10);
        assert_eq!(rewards.drop_epoch(&first).unwrap().spent, 30);
    }

    #[test]
    fn drop_epoch_reserves_budget_and_spends_only_once_into_the_fee_pool() {
        let (env, rewards, _, token, _, _) = setup();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let epoch = BytesN::from_array(&env, &[11; 32]);
        let root = BytesN::from_array(&env, &[12; 32]);
        let batch = BytesN::from_array(&env, &[13; 32]);
        let nullifier = BytesN::from_array(&env, &[14; 32]);
        let consumer = Address::generate(&env);
        rewards.fund_drop(&100);
        rewards.configure_drop_consumer(&consumer);
        assert_eq!(rewards.drop_consumer(), Some(consumer));
        rewards.issue_drop_epoch(&epoch, &root, &80, &1_100);
        assert_eq!(rewards.drop_available(), 20);
        assert_eq!(rewards.drop_reserved(), 80);
        assert!(rewards.try_return_unallocated_drop(&21).is_err());
        assert!(rewards
            .try_issue_drop_epoch(&epoch, &root, &1, &1_100)
            .is_err());

        let pool = rewards.fee_pool();
        rewards.spend_drop_batch(
            &epoch,
            &batch,
            &Vec::from_array(&env, [nullifier.clone()]),
            &30,
        );
        assert_eq!(token.balance(&pool), 30);
        assert_eq!(rewards.drop_allocated(), 30);
        assert_eq!(rewards.drop_reserved(), 50);
        assert_eq!(rewards.drop_available(), 20);
        assert_eq!(rewards.drop_epoch(&epoch).unwrap().spent, 30);
        assert!(rewards
            .try_spend_drop_batch(
                &epoch,
                &batch,
                &Vec::from_array(&env, [BytesN::from_array(&env, &[15; 32])]),
                &1
            )
            .is_err());
        assert!(rewards
            .try_spend_drop_batch(
                &epoch,
                &BytesN::from_array(&env, &[16; 32]),
                &Vec::from_array(&env, [nullifier]),
                &1
            )
            .is_err());
        assert!(rewards
            .try_spend_drop_batch(
                &epoch,
                &BytesN::from_array(&env, &[17; 32]),
                &Vec::from_array(&env, [BytesN::from_array(&env, &[18; 32])]),
                &51
            )
            .is_err());

        env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
        assert!(rewards
            .try_spend_drop_batch(
                &epoch,
                &BytesN::from_array(&env, &[19; 32]),
                &Vec::from_array(&env, [BytesN::from_array(&env, &[20; 32])]),
                &1
            )
            .is_err());
        rewards.expire_drop_epoch(&epoch);
        assert!(rewards.drop_epoch(&epoch).unwrap().released);
        assert_eq!(rewards.drop_reserved(), 0);
        assert_eq!(rewards.drop_available(), 70);
        assert!(rewards.try_expire_drop_epoch(&epoch).is_err());
        assert!(rewards
            .try_issue_drop_epoch(&epoch, &root, &1, &1_200)
            .is_err());
    }
}
