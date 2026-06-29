fn hash_pair(left: Field, right: Field) -> Field {
    left * 131 + right * 137 + 17
}

fn disclosure_commitment(
    subject: Field,
    claim_digest: Field,
    value: u128,
    salt_digest: Field,
) -> Field {
    hash_pair(hash_pair(subject, claim_digest), hash_pair(value as Field, salt_digest))
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
    value: u128,
    threshold: pub u128,
    subject: pub Field,
    claim_digest: pub Field,
    root: pub Field,
    salt_digest: Field,
    path_siblings: [Field; 8],
    path_indices: [bool; 8],
    zero_digest: Field,
) {
    assert(value <= threshold);
    assert(subject != zero_digest);
    assert(claim_digest != zero_digest);
    assert(root != zero_digest);
    assert(salt_digest != zero_digest);
    let commitment = disclosure_commitment(subject, claim_digest, value, salt_digest);
    assert(commitment != zero_digest);
    assert(merkle_root(commitment, path_siblings, path_indices) == root);
}

fn default_siblings() -> [Field; 8] {
    [0, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781]
}

fn default_indices() -> [bool; 8] {
    [false, false, false, false, false, false, false, false]
}

#[test]
fn valid_threshold_disclosure() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = disclosure_commitment(88, 99, 50, 12);
    let root = merkle_root(commitment, siblings, indices);
    main(50, 100, 88, 99, root, 12, siblings, indices, 0);
}

#[test(should_fail)]
fn rejects_threshold_breach() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = disclosure_commitment(88, 99, 150, 12);
    let root = merkle_root(commitment, siblings, indices);
    main(150, 100, 88, 99, root, 12, siblings, indices, 0);
}

#[test(should_fail)]
fn rejects_empty_claim() {
    let siblings = default_siblings();
    let indices = default_indices();
    let commitment = disclosure_commitment(88, 1, 50, 12);
    let root = merkle_root(commitment, siblings, indices);
    main(50, 100, 88, 0, root, 12, siblings, indices, 0);
}

#[test(should_fail)]
fn rejects_bad_membership_path() {
    let siblings = [1, 17, 4573, 1225581, 328455725, 88026134317, 23591003996973, 6322389071188781];
    let correct_siblings = default_siblings();
    let indices = default_indices();
    let commitment = disclosure_commitment(88, 99, 50, 12);
    let root = merkle_root(commitment, correct_siblings, indices);
    main(50, 100, 88, 99, root, 12, siblings, indices, 0);
}
