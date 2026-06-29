fn hash_pair(left: Field, right: Field) -> Field {
    left * 131 + right * 137 + 17
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
    note_amount: u128,
    withdraw_amount: pub u128,
    root: pub Field,
    nullifier: pub Field,
    token_digest: pub Field,
    recipient_digest: pub Field,
    change_commitment: pub Field,
    asset_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
    change_rho_digest: Field,
    change_blinding: Field,
    zero_value: Field,
) {
    assert(note_amount > 0);
    assert(withdraw_amount > 0);
    assert(withdraw_amount <= note_amount);
    assert(root != zero_value);
    assert(nullifier != zero_value);
    assert(token_digest != zero_value);
    assert(recipient_digest != zero_value);
    assert(asset_digest == token_digest);

    let note = note_commitment(
        asset_digest,
        note_amount,
        owner_digest,
        rho_digest,
        blinding,
    );
    assert(merkle_root(note, path_siblings, path_indices) == root);
    assert(hash_pair(spend_secret_digest, rho_digest) == nullifier);

    let change = note_amount - withdraw_amount;
    if change == 0 {
        assert(change_commitment == zero_value);
    } else {
        assert(change_rho_digest != zero_value);
        assert(change_blinding != zero_value);
        assert(change_commitment == note_commitment(
            asset_digest,
            change,
            owner_digest,
            change_rho_digest,
            change_blinding,
        ));
    }
}

#[test]
fn valid_withdrawal_with_change() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, 17569245168735110909994055, 1351, 2, 13, 145875806, 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}

#[test]
fn valid_full_withdrawal() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 10_000, 17569245168735110909994055, 1351, 2, 13, 0, 2, 3, 4, 5, 6, siblings, indices, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_overspend() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 12_000, 17569245168735110909994055, 1351, 2, 13, 0, 2, 3, 4, 5, 6, siblings, indices, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_merkle_path() {
    let siblings = [1, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, 17569245168735110909994055, 1351, 2, 13, 145875806, 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}

#[test(should_fail)]
fn rejects_bad_nullifier() {
    let siblings = [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, 17569245168735110909994055, 999, 2, 13, 145875806, 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}
