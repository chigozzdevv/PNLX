global DROP_POSITION: Field = 0x504e4c5844524f50504f53;
global DROP_RETURN: Field = 0x504e4c5844524f50524554;
global DROP_NULLIFIER: Field = 0x504e4c5844524f504e554c;
global DROP_MARGIN: Field = 0x504e4c5844524f504d4152;

fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
}

fn position_commitment(
    is_long: bool, size: u128, entry_price: u128, margin: u128, funding_index: u128,
    market_digest: Field, owner_digest: Field, rho: Field, blinding: Field,
    sponsored_principal: u128, reserve_digest: Field, spend_secret_digest: Field,
) -> Field {
    let side = if is_long { 1 } else { 2 };
    let base = hash_pair(
        hash_pair(hash_pair(market_digest, side), hash_pair(size as Field, entry_price as Field)),
        hash_pair(hash_pair(margin as Field, funding_index as Field),
            hash_pair(owner_digest, hash_pair(rho, blinding))),
    );
    hash_pair(DROP_POSITION, hash_pair(base,
        hash_pair(sponsored_principal as Field, hash_pair(reserve_digest, spend_secret_digest))))
}

fn margin_commitment(asset: Field, amount: u128, owner: Field, rho: Field, blinding: Field,
    spend_secret_digest: Field) -> Field {
    hash_pair(DROP_MARGIN, hash_pair(hash_pair(asset, amount as Field),
        hash_pair(owner, hash_pair(hash_pair(rho, blinding), spend_secret_digest))))
}

fn return_commitment(reserve: Field, position: Field, amount: u128, rho: Field) -> Field {
    hash_pair(DROP_RETURN, hash_pair(reserve, hash_pair(amount as Field, hash_pair(position, rho))))
}

fn merkle_root(leaf: Field, siblings: [Field; 20], indices: [bool; 20]) -> Field {
    let mut current = leaf;
    for i in 0..20 {
        current = if indices[i] { hash_pair(siblings[i], current) } else { hash_pair(current, siblings[i]) };
    }
    current
}

fn equity(
    is_long: bool, size: u128, entry: u128, mark: u128, margin: u128,
    funding_index: u128, current_funding_index: u128, fee: u128,
) -> (u128, bool) {
    let profitable = if is_long { mark >= entry } else { entry >= mark };
    let delta = if mark >= entry { mark - entry } else { entry - mark };
    let pnl = size * delta / 100_000_000;
    let funding_increased = current_funding_index >= funding_index;
    let funding_delta = if funding_increased { current_funding_index - funding_index } else { funding_index - current_funding_index };
    let funding = size * funding_delta / 100_000_000;
    let funding_credit = is_long != funding_increased;
    let credits = margin + (if profitable { pnl } else { 0 }) + (if funding_credit { funding } else { 0 });
    let debits = (if profitable { 0 } else { pnl }) + (if funding_credit { 0 } else { funding }) + fee;
    (if credits > debits { credits - debits } else { 0 }, credits < debits)
}

fn split(equity: u128, principal: u128) -> (u128, u128) {
    let reserve = if equity < principal { equity } else { principal };
    (equity - reserve, reserve)
}

fn main(
    market_digest: pub Field,
    asset_digest: pub Field,
    reserve_digest: pub Field,
    mark_price: pub u128,
    current_funding_index: pub u128,
    maintenance_rate: pub u128,
    liquidation: pub bool,
    position_root: pub Field,
    position_commitment_public: pub Field,
    position_nullifier: pub Field,
    margin_output_commitment: pub Field,
    reserve_output_commitment: pub Field,
    is_long: bool, size: u128, entry_price: u128, margin: u128, funding_index: u128,
    owner_digest: Field, rho: Field, blinding: Field, spend_secret_digest: Field, sponsored_principal: u128,
    margin_output_rho: Field, margin_output_blinding: Field,
    margin_output_spend_secret_digest: Field, reserve_output_rho: Field,
    siblings: [Field; 20], indices: [bool; 20],
) {
    assert(size > 0);
    assert(entry_price > 0);
    assert(mark_price > 0);
    assert(sponsored_principal > 0);
    assert(market_digest != 0);
    assert(asset_digest != 0);
    assert(reserve_digest != 0);
    assert(owner_digest != 0);
    assert(rho != 0);
    assert(blinding != 0);
    assert(spend_secret_digest != 0);
    assert(maintenance_rate > 0);
    assert(maintenance_rate <= 1_000_000);
    let position = position_commitment(is_long, size, entry_price, margin, funding_index,
        market_digest, owner_digest, rho, blinding, sponsored_principal, reserve_digest, spend_secret_digest);
    assert(position == position_commitment_public);
    assert(hash_pair(DROP_NULLIFIER, hash_pair(spend_secret_digest, rho)) == position_nullifier);
    assert(merkle_root(position, siblings, indices) == position_root);
    let (net_equity, insolvent) = equity(is_long, size, entry_price, mark_price, margin,
        funding_index, current_funding_index, 0);
    if liquidation {
        let maintenance = (size * mark_price / 100_000_000) * maintenance_rate / 1_000_000;
        assert(net_equity < maintenance);
    } else {
        assert(!insolvent);
    }
    let (trader_amount, reserve_amount) = split(net_equity, sponsored_principal);
    if trader_amount == 0 {
        assert(margin_output_commitment == 0);
    } else {
        assert(margin_output_rho != 0);
        assert(margin_output_blinding != 0);
        assert(margin_output_spend_secret_digest != 0);
        assert(margin_commitment(asset_digest, trader_amount, owner_digest,
            margin_output_rho, margin_output_blinding, margin_output_spend_secret_digest) == margin_output_commitment);
    }
    if reserve_amount == 0 {
        assert(reserve_output_commitment == 0);
    } else {
        assert(reserve_output_rho != 0);
        assert(return_commitment(reserve_digest, position, reserve_amount, reserve_output_rho) == reserve_output_commitment);
    }
}

#[test]
fn reserve_has_priority_on_profit_loss_and_insolvency() {
    assert(split(120, 10) == (110, 10));
    assert(split(80, 10) == (70, 10));
    assert(split(6, 10) == (0, 6));
    assert(split(0, 10) == (0, 0));
}

#[test]
fn funding_credit_offsets_losses_before_clamping() {
    assert(equity(true, 100_000_000, 100, 80, 10, 30, 0, 0) == (20, false));
    assert(equity(true, 100_000_000, 100, 80, 10, 0, 0, 0) == (0, true));
}

fn exercise_close(principal: u128, trader_amount: u128, reserve_amount: u128,
    nullifier_offset: Field, liquidation: bool, witness_secret: Field, mark: u128) {
    let position = position_commitment(true, 100_000_000, 100, 100, 0, 2, 3, 4, 5, 10, 6, 12);
    let mut siblings = [0; 20];
    let mut empty = 0;
    for i in 0..20 {
        siblings[i] = empty;
        empty = hash_pair(empty, empty);
    }
    let indices = [false; 20];
    main(2, 7, 6, mark, 0, 100_000, liquidation, merkle_root(position, siblings, indices),
        position, hash_pair(DROP_NULLIFIER, hash_pair(12, 4)) + nullifier_offset,
        if trader_amount == 0 { 0 } else { margin_commitment(7, trader_amount, 3, 8, 9, 11) },
        if reserve_amount == 0 { 0 } else { return_commitment(6, position, reserve_amount, 10) },
        true, 100_000_000, 100, 100, 0, 3, 4, 5, witness_secret, principal,
        8, 9, 11, 10, siblings, indices);
}

#[test]
fn closes_to_private_user_note_and_restricted_reserve_receipt() {
    exercise_close(10, 110, 10, 0, false, 12, 120);
}

#[test]
fn closes_without_a_zero_value_user_note() {
    exercise_close(10, 0, 10, 0, false, 12, 10);
}

#[test]
fn insolvent_liquidation_creates_no_zero_value_claims() {
    let position = position_commitment(true, 1_000_000_000, 100, 100, 0, 2, 3, 4, 5, 10, 6, 12);
    let mut siblings = [0; 20];
    let mut empty = 0;
    for i in 0..20 {
        siblings[i] = empty;
        empty = hash_pair(empty, empty);
    }
    main(2, 7, 6, 90, 0, 100_000, true, merkle_root(position, siblings, [false; 20]),
        position, hash_pair(DROP_NULLIFIER, hash_pair(12, 4)), 0, 0,
        true, 1_000_000_000, 100, 100, 0, 3, 4, 5, 12, 10,
        0, 0, 0, 0, siblings, [false; 20]);
}

#[test(should_fail)]
fn cannot_withdraw_the_sponsored_principal() {
    exercise_close(10, 120, 0, 0, false, 12, 120);
}

#[test(should_fail)]
fn principal_cannot_be_changed_at_close() {
    exercise_close(1, 119, 1, 0, false, 12, 120);
}

#[test(should_fail)]
fn cannot_choose_a_fresh_nullifier() {
    exercise_close(10, 110, 10, 1, false, 12, 120);
}

#[test(should_fail)]
fn cannot_close_with_a_different_spend_secret() {
    exercise_close(10, 110, 10, 0, false, 13, 120);
}

#[test(should_fail)]
fn healthy_position_cannot_be_liquidated() {
    exercise_close(10, 110, 10, 0, true, 12, 120);
}
