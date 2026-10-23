global POSITION_DOMAIN: Field = 0x504e4c58504f534954494f4e;
global SECURE_MARGIN_DOMAIN: Field = 0x504e4c5844524f504d4152;
global PRICE_SCALE: u128 = 100_000_000;
global RATE_SCALE: u128 = 1_000_000;
global MAX_SIGNED_ABS: u128 = 170141183460469231731687303715884105727;

fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
}

fn signed_index(abs_value: u128, is_negative: bool) -> Field {
    assert(abs_value <= MAX_SIGNED_ABS);
    if abs_value == 0 { assert(!is_negative); }
    if is_negative { -(abs_value as Field) } else { abs_value as Field }
}

fn funding_payment(is_long: bool, size: u128, old_abs: u128, old_negative: bool,
    current_abs: u128, current_negative: bool) -> (u128, bool) {
    let _old = signed_index(old_abs, old_negative);
    let _current = signed_index(current_abs, current_negative);
    let increased = if old_negative != current_negative {
        old_negative
    } else if old_negative {
        old_abs >= current_abs
    } else { current_abs >= old_abs };
    let delta = if old_negative != current_negative { old_abs + current_abs }
        else if old_abs >= current_abs { old_abs - current_abs }
        else { current_abs - old_abs };
    let amount = (size * delta) / PRICE_SCALE;
    (amount, (amount != 0) & (is_long != increased))
}

fn position_commitment(is_long: bool, size: u128, entry_price: u128, margin: u128,
    funding_index: Field, market_digest: Field, owner_digest: Field, rho: Field,
    blinding: Field, spend_secret_digest: Field) -> Field {
    let side = if is_long { 1 as Field } else { 2 as Field };
    let left = hash_pair(hash_pair(market_digest, side), hash_pair(size as Field, entry_price as Field));
    let right = hash_pair(hash_pair(margin as Field, funding_index), hash_pair(owner_digest, hash_pair(rho, blinding)));
    hash_pair(POSITION_DOMAIN, hash_pair(left, hash_pair(right, spend_secret_digest)))
}

fn note_commitment(asset: Field, amount: u128, owner: Field, rho: Field,
    blinding: Field, spend_secret_digest: Field) -> Field {
    hash_pair(SECURE_MARGIN_DOMAIN, hash_pair(hash_pair(asset, amount as Field),
        hash_pair(owner, hash_pair(hash_pair(rho, blinding), spend_secret_digest))))
}

fn merkle_root(leaf: Field, siblings: [Field; 20], indices: [bool; 20]) -> Field {
    let mut node = leaf;
    for i in 0..20 { node = if indices[i] { hash_pair(siblings[i], node) } else { hash_pair(node, siblings[i]) }; }
    node
}

fn empty_siblings() -> [Field; 20] {
    let mut siblings = [0; 20];
    let mut node: Field = 0;
    for i in 0..20 { siblings[i] = node; node = hash_pair(node, node); }
    siblings
}

fn pnl(is_long: bool, size: u128, entry: u128, mark: u128) -> (u128, bool) {
    let profit = if is_long { mark >= entry } else { entry >= mark };
    let delta = if mark >= entry { mark - entry } else { entry - mark };
    (size * delta / PRICE_SCALE, profit)
}

fn equity_parts(is_long: bool, size: u128, entry: u128, mark: u128, margin: u128,
    old_abs: u128, old_negative: bool, current_abs: u128, current_negative: bool) -> (u128, u128) {
    let (pnl_amount, profit) = pnl(is_long, size, entry, mark);
    let (funding_amount, credit) = funding_payment(is_long, size, old_abs, old_negative, current_abs, current_negative);
    let credits = margin + (if profit { pnl_amount } else { 0 }) + (if credit { funding_amount } else { 0 });
    let debits = (if profit { 0 } else { pnl_amount }) + (if credit { 0 } else { funding_amount });
    (credits, debits)
}

fn main(
    is_long: bool, size: u128, close_size: u128, entry_price: u128,
    mark_price: pub u128, margin: u128, funding_index: Field,
    funding_payment_abs: u128, funding_is_credit: bool, fee: u128,
    new_margin: u128, remaining_margin: u128, margin_output_amount: u128,
    price_scale: pub u128, position_root: pub Field,
    position_commitment_public: pub Field, position_nullifier: pub Field,
    close_commitment: pub Field, new_position_commitment: pub Field,
    margin_output_commitment: pub Field, market_digest: pub Field,
    current_funding_index_abs: pub u128, current_funding_index_is_negative: pub bool,
    funding_index_abs: u128, funding_index_is_negative: bool,
    owner_digest: Field, rho_digest: Field, blinding: Field, spend_secret_digest: Field,
    new_position_rho_digest: Field, new_position_blinding: Field,
    margin_output_asset_digest: Field, margin_output_rho_digest: Field,
    margin_output_blinding: Field, margin_output_spend_secret_digest: Field,
    path_siblings: [Field; 20], path_indices: [bool; 20], zero_value: Field,
) {
    assert(zero_value == 0);
    assert((size > 0) & (close_size == size));
    assert((entry_price > 0) & (mark_price > 0));
    assert(price_scale == PRICE_SCALE);
    assert((market_digest != 0) & (owner_digest != 0) & (rho_digest != 0) & (blinding != 0) & (spend_secret_digest != 0));
    assert((position_root != 0) & (position_commitment_public != 0) & (position_nullifier != 0));
    assert((close_commitment != 0) & (new_position_commitment != 0) & (margin_output_commitment != 0));
    assert((new_position_commitment != close_commitment) & (margin_output_commitment != close_commitment));
    assert((new_position_rho_digest != 0) & (new_position_blinding != 0));
    assert((margin_output_asset_digest != 0) & (margin_output_rho_digest != 0) & (margin_output_blinding != 0) & (margin_output_spend_secret_digest != 0));
    assert(funding_index == signed_index(funding_index_abs, funding_index_is_negative));
    let position = position_commitment(is_long, size, entry_price, margin, funding_index,
        market_digest, owner_digest, rho_digest, blinding, spend_secret_digest);
    assert(position == position_commitment_public);
    assert(merkle_root(position, path_siblings, path_indices) == position_root);
    assert(hash_pair(spend_secret_digest, rho_digest) == position_nullifier);
    let (funding, credit) = funding_payment(is_long, size, funding_index_abs, funding_index_is_negative,
        current_funding_index_abs, current_funding_index_is_negative);
    assert((funding_payment_abs == funding) & (funding_is_credit == credit));
    assert(fee == 0);
    let (credits, debits) = equity_parts(is_long, size, entry_price, mark_price, margin,
        funding_index_abs, funding_index_is_negative, current_funding_index_abs, current_funding_index_is_negative);
    assert(credits >= debits);
    assert(new_margin == credits - debits);
    assert((remaining_margin == 0) & (margin_output_amount == new_margin));
    assert(position_commitment(is_long, 0, entry_price, 0, funding_index,
        market_digest, owner_digest, new_position_rho_digest, new_position_blinding,
        spend_secret_digest) == new_position_commitment);
    assert(note_commitment(margin_output_asset_digest, margin_output_amount, owner_digest,
        margin_output_rho_digest, margin_output_blinding, margin_output_spend_secret_digest) == margin_output_commitment);
}

fn exercise(is_long: bool, mark: u128, old_abs: u128, old_negative: bool,
    current_abs: u128, current_negative: bool, funding_override: u128, secret: Field, public_market: Field, fee: u128) {
    let size = 100_000_000;
    let entry = 100;
    let margin = 1000;
    let index = signed_index(old_abs, old_negative);
    let position = position_commitment(is_long, size, entry, margin, index, 2, 3, 4, 5, 6);
    let siblings = empty_siblings();
    let indices = [false; 20];
    let root = merkle_root(position, siblings, indices);
    let (funding, credit) = funding_payment(is_long, size, old_abs, old_negative, current_abs, current_negative);
    let (credits, debits) = equity_parts(is_long, size, entry, mark, margin, old_abs, old_negative, current_abs, current_negative);
    let output = credits - debits;
    main(is_long, size, size, entry, mark, margin, index, funding + funding_override, credit, fee,
        output, 0, output, PRICE_SCALE, root, position, hash_pair(secret, 4), 13,
        position_commitment(is_long, 0, entry, 0, index, 2, 3, 7, 8, secret),
        note_commitment(9, output, 3, 10, 11, 12), public_market,
        current_abs, current_negative, old_abs, old_negative, 3, 4, 5, secret,
        7, 8, 9, 10, 11, 12, siblings, indices, 0);
}

#[test]
fn long_profit() { exercise(true, 110, 0, false, 0, false, 0, 6, 2, 0); }
#[test]
fn short_profit() { exercise(false, 90, 0, false, 0, false, 0, 6, 2, 0); }
#[test]
fn long_loss() { exercise(true, 90, 0, false, 0, false, 0, 6, 2, 0); }
#[test]
fn authenticated_funding_debit() { exercise(true, 100, 0, false, 10, false, 0, 6, 2, 0); }
#[test]
fn authenticated_funding_credit() { exercise(false, 100, 0, false, 10, false, 0, 6, 2, 0); }
#[test]
fn funding_crosses_zero() { exercise(true, 100, 5, false, 7, true, 0, 6, 2, 0); }
#[test(should_fail)]
fn rejects_unbound_spending_secret() { exercise(true, 110, 0, false, 0, false, 0, 99, 2, 0); }
#[test(should_fail)]
fn rejects_fabricated_funding() { exercise(true, 110, 0, false, 0, false, 100, 6, 2, 0); }
#[test(should_fail)]
fn rejects_wrong_market() { exercise(true, 110, 0, false, 0, false, 0, 6, 99, 0); }
#[test(should_fail)]
fn rejects_unconfigured_close_fee() { exercise(true, 110, 0, false, 0, false, 0, 6, 2, 1); }
#[test(should_fail)]
fn rejects_negative_zero_index() { exercise(true, 110, 0, true, 0, false, 0, 6, 2, 0); }
#[test(should_fail)]
fn rejects_unilateral_bankrupt_claim() { exercise(true, 1, 0, false, 1000, false, 0, 6, 2, 0); }
