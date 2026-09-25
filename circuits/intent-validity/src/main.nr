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

#[test]
fn hash_pair_matches_typescript_vector() {
    assert(hash_pair(1, 2) == 1594597865669602199208529098208508950092942746041644072252494753744672355203);
    assert(hash_pair(1, 139) != hash_pair(138, 8));
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
    merkle_root(note_commitment(2, 12_000, 3, 4, 5), empty_siblings(), indices)
}

fn compute_intent_commitment(
    batch_digest: Field,
    market_digest: Field,
    owner_commitment_field: Field,
    is_long: bool,
    size: u128,
    limit_price: u128,
    margin: u128,
    note_nullifier: Field,
    nonce_digest: Field,
    salt_digest: Field,
) -> Field {
    let side = if is_long { 1 } else { 2 };
    let scope = hash_pair(
        hash_pair(batch_digest, market_digest),
        hash_pair(owner_commitment_field, side),
    );
    let economics = hash_pair(
        hash_pair(size as Field, limit_price as Field),
        hash_pair(margin as Field, note_nullifier),
    );
    let entropy = hash_pair(nonce_digest, salt_digest);
    hash_pair(hash_pair(scope, economics), entropy)
}

fn main(
    size: u128,
    margin: u128,
    limit_price: u128,
    is_long: bool,
    expiry_batch: u128,
    note_amount: u128,
    asset_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
    current_batch: pub u128,
    batch_digest: pub Field,
    market_digest: pub Field,
    owner_commitment_field: pub Field,
    intent_commitment: pub Field,
    margin_root: pub Field,
    note_commitment_public: pub Field,
    note_nullifier: pub Field,
    note_change_commitment: pub Field,
    nonce_digest: Field,
    salt_digest: Field,
    change_rho_digest: Field,
    change_blinding: Field,
    zero_commitment: Field,
) {
    assert(size > 0);
    assert(margin > 0);
    assert(note_amount >= margin);
    assert(limit_price > 0);
    assert(expiry_batch >= current_batch);
    assert(intent_commitment != zero_commitment);
    assert(batch_digest != zero_commitment);
    assert(market_digest != zero_commitment);
    assert(owner_commitment_field != zero_commitment);
    assert(margin_root != zero_commitment);
    assert(note_commitment_public != zero_commitment);
    assert(note_nullifier != zero_commitment);
    assert(nonce_digest != zero_commitment);
    assert(salt_digest != zero_commitment);

    let computed_note_commitment = note_commitment(
        asset_digest,
        note_amount,
        owner_digest,
        rho_digest,
        blinding,
    );
    assert(computed_note_commitment == note_commitment_public);
    assert(merkle_root(note_commitment_public, path_siblings, path_indices) == margin_root);
    assert(hash_pair(spend_secret_digest, rho_digest) == note_nullifier);

    let change = note_amount - margin;
    if change == 0 {
        assert(note_change_commitment == zero_commitment);
    } else {
        assert(change_rho_digest != zero_commitment);
        assert(change_blinding != zero_commitment);
        assert(note_change_commitment == note_commitment(
            asset_digest,
            change,
            owner_digest,
            change_rho_digest,
            change_blinding,
        ));
    }

    assert(compute_intent_commitment(
        batch_digest,
        market_digest,
        owner_commitment_field,
        is_long,
        size,
        limit_price,
        margin,
        note_nullifier,
        nonce_digest,
        salt_digest,
    ) == intent_commitment);
}

#[test]
fn valid_intent() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = compute_intent_commitment(20, 21, 22, true, 1, 5_100_000_000_000, 12_000, hash_pair(6, 4), 23, 24);
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, commitment, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_expired_intent() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = compute_intent_commitment(20, 21, 22, true, 1, 5_100_000_000_000, 12_000, hash_pair(6, 4), 23, 24);
    main(1, 12_000, 5_100_000_000_000, true, 8, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, commitment, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_zero_size() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(0, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, 77, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_empty_margin_root() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = compute_intent_commitment(20, 21, 22, true, 1, 5_100_000_000_000, 12_000, hash_pair(6, 4), 23, 24);
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, commitment, 0, note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_empty_nullifier() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, 77, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), 0, 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_note_opening() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = compute_intent_commitment(20, 21, 22, true, 1, 5_100_000_000_000, 12_000, hash_pair(6, 4), 23, 24);
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 999, 6, siblings, indices, 9, 20, 21, 22, commitment, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_merkle_path() {
    let mut siblings = empty_siblings();
    siblings[0] = 1;
    let indices = [false, false, false, false, false, false, false, false];
    let commitment = compute_intent_commitment(20, 21, 22, true, 1, 5_100_000_000_000, 12_000, hash_pair(6, 4), 23, 24);
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, commitment, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_intent_commitment() {
    let siblings = empty_siblings();
    let indices = [false, false, false, false, false, false, false, false];
    main(1, 12_000, 5_100_000_000_000, true, 10, 12_000, 2, 3, 4, 5, 6, siblings, indices, 9, 20, 21, 22, 999, valid_note_root(), note_commitment(2, 12_000, 3, 4, 5), hash_pair(6, 4), 0, 23, 24, 0, 0, 0);
}
