fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
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

fn empty_siblings() -> [Field; 8] {
    let mut siblings = [0; 8];
    let mut empty: Field = 0;
    for i in 0..8 {
        siblings[i] = empty;
        empty = hash_pair(empty, empty);
    }
    siblings
}

fn valid_note_root() -> Field {
    let indices = [false; 8];
    merkle_root(note_commitment(2, 10_000, 3, 4, 5), empty_siblings(), indices)
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
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, valid_note_root(), hash_pair(6, 4), 2, 13, note_commitment(2, 6_000, 3, 7, 8), 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}

#[test]
fn valid_full_withdrawal() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 10_000, valid_note_root(), hash_pair(6, 4), 2, 13, 0, 2, 3, 4, 5, 6, siblings, indices, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_overspend() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 12_000, valid_note_root(), hash_pair(6, 4), 2, 13, 0, 2, 3, 4, 5, 6, siblings, indices, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_merkle_path() {
    let mut siblings = empty_siblings();
    siblings[0] = 1;
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, valid_note_root(), hash_pair(6, 4), 2, 13, note_commitment(2, 6_000, 3, 7, 8), 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}

#[test(should_fail)]
fn rejects_bad_nullifier() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(10_000, 4_000, valid_note_root(), 999, 2, 13, note_commitment(2, 6_000, 3, 7, 8), 2, 3, 4, 5, 6, siblings, indices, 7, 8, 0);
}
