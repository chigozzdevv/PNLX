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

fn note_commitment(
    asset_digest: Field,
    note_amount: u128,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
) -> Field {
    let amount_field = note_amount as Field;
    let left = hash_pair(asset_digest, amount_field);
    let right = hash_pair(owner_digest, hash_pair(rho_digest, blinding));
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
    close_size: u128,
    entry_price: u128,
    mark_price: pub u128,
    margin: u128,
    funding_index: u128,
    funding_payment_abs: u128,
    funding_is_credit: bool,
    fee: u128,
    new_margin: u128,
    remaining_margin: u128,
    margin_output_amount: u128,
    price_scale: pub u128,
    position_root: pub Field,
    position_commitment_public: pub Field,
    position_nullifier: pub Field,
    close_commitment: pub Field,
    new_position_commitment: pub Field,
    new_position_root: pub Field,
    margin_output_commitment: pub Field,
    market_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
    new_position_rho_digest: Field,
    new_position_blinding: Field,
    margin_output_asset_digest: Field,
    margin_output_rho_digest: Field,
    margin_output_blinding: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
    zero_value: Field,
) {
    assert(size > 0);
    assert(close_size > 0);
    assert(close_size <= size);
    assert(entry_price > 0);
    assert(mark_price > 0);
    assert(price_scale > 0);
    assert(position_root != zero_value);
    assert(position_commitment_public != zero_value);
    assert(position_nullifier != zero_value);
    assert(close_commitment != zero_value);
    assert(new_position_commitment != zero_value);
    assert(new_position_root != zero_value);
    assert(margin_output_commitment != zero_value);
    assert(new_position_commitment != close_commitment);
    assert(new_position_root != position_root);
    assert(margin_output_commitment != close_commitment);
    assert(new_position_rho_digest != zero_value);
    assert(new_position_blinding != zero_value);
    assert(margin_output_asset_digest != zero_value);
    assert(margin_output_rho_digest != zero_value);
    assert(margin_output_blinding != zero_value);

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

    let is_profit = if is_long {
        mark_price >= entry_price
    } else {
        entry_price >= mark_price
    };
    let price_delta = if is_profit {
        if is_long { mark_price - entry_price } else { entry_price - mark_price }
    } else {
        if is_long { entry_price - mark_price } else { mark_price - entry_price }
    };
    let pnl_abs = (close_size * price_delta) / price_scale;
    let margin_after_pnl = if is_profit {
        margin + pnl_abs
    } else {
        assert(margin >= pnl_abs);
        margin - pnl_abs
    };
    let margin_after_funding = if funding_is_credit {
        margin_after_pnl + funding_payment_abs
    } else {
        assert(margin_after_pnl >= funding_payment_abs);
        margin_after_pnl - funding_payment_abs
    };
    assert(margin_after_funding >= fee);
    assert(new_margin == margin_after_funding - fee);
    assert(remaining_margin + margin_output_amount == new_margin);

    let remaining_size = size - close_size;
    if remaining_size == 0 {
        assert(remaining_margin == 0);
    } else {
        assert(remaining_margin > 0);
    }
    let expected_new_position = position_commitment(
        is_long,
        remaining_size,
        entry_price,
        remaining_margin,
        funding_index,
        market_digest,
        owner_digest,
        new_position_rho_digest,
        new_position_blinding,
    );
    assert(expected_new_position == new_position_commitment);

    let expected_margin_output = note_commitment(
        margin_output_asset_digest,
        margin_output_amount,
        owner_digest,
        margin_output_rho_digest,
        margin_output_blinding,
    );
    assert(expected_margin_output == margin_output_commitment);
}

fn default_siblings() -> [Field; 8] {
    [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781]
}

fn default_indices() -> [bool; 8] {
    [false, false, false, false, false, false, false, false]
}

fn exercise_close(
    is_long: bool,
    size: u128,
    close_size: u128,
    entry_price: u128,
    mark_price: u128,
    margin: u128,
    funding_index: u128,
    funding_payment_abs: u128,
    funding_is_credit: bool,
    fee: u128,
    new_margin: u128,
    remaining_margin: u128,
    margin_output_amount: u128,
    position_root: Field,
    position_commitment_public: Field,
    position_nullifier: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
) {
    let market_digest = 2;
    let owner_digest = 3;
    let new_position = position_commitment(
        is_long,
        size - close_size,
        entry_price,
        remaining_margin,
        funding_index,
        market_digest,
        owner_digest,
        7,
        8,
    );
    let margin_output = note_commitment(9, margin_output_amount, owner_digest, 10, 11);
    main(
        is_long,
        size,
        close_size,
        entry_price,
        mark_price,
        margin,
        funding_index,
        funding_payment_abs,
        funding_is_credit,
        fee,
        new_margin,
        remaining_margin,
        margin_output_amount,
        100_000_000,
        position_root,
        position_commitment_public,
        position_nullifier,
        13,
        new_position,
        16,
        margin_output,
        market_digest,
        owner_digest,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        path_siblings,
        path_indices,
        0,
    );
}

#[test]
fn valid_long_profit_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 17_990, 0, 17_990, root, commitment, 1351, siblings, indices);
}

#[test]
fn valid_long_loss_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 4_800_000_000_000, 12_000, 0, 0, false, 10, 9_990, 0, 9_990, root, commitment, 1351, siblings, indices);
}

#[test]
fn valid_short_profit_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(false, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(false, 1, 1, 5_000_000_000_000, 4_400_000_000_000, 12_000, 0, 0, false, 10, 17_990, 0, 17_990, root, commitment, 1351, siblings, indices);
}

#[test]
fn valid_partial_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 4, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 4, 2, 5_000_000_000_000, 5_100_000_000_000, 12_000, 0, 0, false, 10, 13_990, 13_990, 0, root, commitment, 1351, siblings, indices);
}

#[test]
fn valid_short_funding_credit_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(false, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(false, 1, 1, 5_000_000_000_000, 5_000_000_000_000, 12_000, 0, 100, true, 10, 12_090, 0, 12_090, root, commitment, 1351, siblings, indices);
}

#[test(should_fail)]
fn rejects_bad_pnl() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 18_000, 0, 18_000, root, commitment, 1351, siblings, indices);
}

#[test(should_fail)]
fn rejects_over_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 2, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 23_990, 0, 23_990, root, commitment, 1351, siblings, indices);
}

#[test(should_fail)]
fn rejects_insolvent_close() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 3_000_000_000_000, 12_000, 0, 0, false, 10, 0, 0, 0, root, commitment, 1351, siblings, indices);
}

#[test(should_fail)]
fn rejects_bad_position_path() {
    let siblings = [1, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let correct_siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, correct_siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 17_990, 0, 17_990, root, commitment, 1351, siblings, indices);
}

#[test(should_fail)]
fn rejects_bad_position_nullifier() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    exercise_close(true, 1, 1, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 17_990, 0, 17_990, root, commitment, 999, siblings, indices);
}

#[test(should_fail)]
fn rejects_bad_output_commitment() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = position_commitment(true, 1, 5_000_000_000_000, 12_000, 0, 2, 3, 4, 5);
    let root = merkle_root(commitment, siblings, indices);
    main(true, 1, 1, 5_000_000_000_000, 5_600_000_000_000, 12_000, 0, 0, false, 10, 17_990, 0, 17_990, 100_000_000, root, commitment, 1351, 13, 14, 16, note_commitment(9, 17_990, 3, 10, 11), 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, siblings, indices, 0);
}
