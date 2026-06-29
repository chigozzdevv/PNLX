fn hash_pair(left: Field, right: Field) -> Field {
    left * 131 + right * 137 + 17
}

fn position_commitment(
    is_long: bool,
    size: u128,
    entry_price: u128,
    margin: u128,
    funding_index: u128,
    market_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
) -> Field {
    let side = if is_long { 1 as Field } else { 2 as Field };
    let left = hash_pair(
        hash_pair(market_digest, side),
        hash_pair(size as Field, entry_price as Field),
    );
    let right = hash_pair(
        hash_pair(margin as Field, funding_index as Field),
        hash_pair(owner_digest, hash_pair(rho_digest, blinding)),
    );
    hash_pair(left, right)
}

fn merkle_root(leaf: Field, path_siblings: [Field; 8], path_indices: [bool; 8]) -> Field {
    let mut current = leaf;
    for i in 0..8 {
        let sibling = path_siblings[i];
        let left = if path_indices[i] { sibling } else { current };
        let right = if path_indices[i] { current } else { sibling };
        current = hash_pair(left, right);
    }
    current
}

fn main(
    is_long: bool,
    size: u128,
    entry_price: u128,
    mark_price: pub u128,
    margin: u128,
    funding_index: u128,
    funding_payment_abs: u128,
    funding_is_credit: bool,
    maintenance_rate: pub u128,
    price_scale: pub u128,
    rate_scale: pub u128,
    position_root: pub Field,
    position_commitment_public: pub Field,
    position_nullifier: pub Field,
    reward_commitment: pub Field,
    market_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
    zero_value: Field,
) {
    assert(size > 0);
    assert(entry_price > 0);
    assert(mark_price > 0);
    assert(price_scale > 0);
    assert(rate_scale > 0);
    assert(position_root != zero_value);
    assert(position_commitment_public != zero_value);
    assert(position_nullifier != zero_value);
    assert(reward_commitment != zero_value);
    let computed_position = position_commitment(
        is_long,
        size,
        entry_price,
        margin,
        funding_index,
        market_digest,
        owner_digest,
        rho_digest,
        blinding,
    );
    assert(computed_position == position_commitment_public);
    assert(merkle_root(position_commitment_public, path_siblings, path_indices) == position_root);
    assert(hash_pair(spend_secret_digest, rho_digest) == position_nullifier);

    let adverse_delta = if is_long {
        if entry_price > mark_price { entry_price - mark_price } else { 0 }
    } else {
        if mark_price > entry_price { mark_price - entry_price } else { 0 }
    };
    let loss = (size * adverse_delta) / price_scale;
    let equity_before_funding = if margin > loss { margin - loss } else { 0 };
    let equity = if funding_is_credit {
        equity_before_funding + funding_payment_abs
    } else if equity_before_funding > funding_payment_abs {
        equity_before_funding - funding_payment_abs
    } else {
        0
    };
    let notional = (size * mark_price) / price_scale;
    let maintenance = (notional * maintenance_rate) / rate_scale;
    assert(equity < maintenance);
}

#[test]
fn valid_liquidation() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(true, 1, 50_000_000_000, 5_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(true, 1, 50_000_000_000, 40_000_000_000, 5_000, 0, 0, false, 100_000, 1_000_000, 1_000_000, root, commitment, 1351, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}

#[test]
fn valid_short_funding_credit_liquidation() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(false, 1, 50_000_000_000, 5_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(false, 1, 50_000_000_000, 60_000_000_000, 5_000, 0, 100, true, 100_000, 1_000_000, 1_000_000, root, commitment, 1351, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}

#[test(should_fail)]
fn healthy_position() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(true, 1, 50_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(true, 1, 50_000_000_000, 49_000_000_000, 12_000, 0, 0, false, 100_000, 1_000_000, 1_000_000, root, commitment, 1351, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}

#[test(should_fail)]
fn credit_can_keep_short_healthy() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(false, 1, 50_000_000_000, 5_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(false, 1, 50_000_000_000, 54_000_000_000, 5_000, 0, 10_000, true, 100_000, 1_000_000, 1_000_000, root, commitment, 1351, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}

#[test(should_fail)]
fn rejects_bad_position_path() {
    let siblings = [1, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let correct_siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(true, 1, 50_000_000_000, 5_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, correct_siblings, indices);
    main(true, 1, 50_000_000_000, 40_000_000_000, 5_000, 0, 0, false, 100_000, 1_000_000, 1_000_000, root, commitment, 1351, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}

#[test(should_fail)]
fn rejects_bad_position_nullifier() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = position_commitment(true, 1, 50_000_000_000, 5_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(true, 1, 50_000_000_000, 40_000_000_000, 5_000, 0, 0, false, 100_000, 1_000_000, 1_000_000, root, commitment, 999, 13, 2, 3, 4, 5, 6, siblings, indices, 0);
}
