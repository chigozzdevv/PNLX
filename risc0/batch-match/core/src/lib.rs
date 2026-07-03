use num_bigint::{BigInt, BigUint};
use num_traits::Zero;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FIELD_PRIME_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const FIELD_MERKLE_DEPTH: usize = 8;
const LEFT_FACTOR: u32 = 131;
const RIGHT_FACTOR: u32 = 137;
const DOMAIN_FACTOR: u32 = 17;
const PRICE_SCALE: u128 = 100_000_000;
const RATE_SCALE: u128 = 1_000_000;
const MAX_PUBLIC_ITEMS: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProofRequest {
    pub batch_id: String,
    pub intents: Vec<RecoveredIntent>,
    pub market: MarketInput,
    pub new_root: String,
    pub old_root: String,
    pub position_commitments: Vec<String>,
    pub expected: SettlementDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarketInput {
    pub funding_index: String,
    pub initial_margin_rate: String,
    pub market_id: String,
    pub max_leverage: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RecoveredIntent {
    pub batch_id: String,
    pub intent_commitment: String,
    pub limit_price: String,
    pub margin: String,
    pub market_id: String,
    pub note_change_commitment: String,
    pub note_nullifier: String,
    pub owner_commitment: String,
    pub signed_size: String,
    pub source_intent_commitment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SettlementDraft {
    pub aggregate_volume: String,
    pub batch_id: String,
    pub fill_count: u32,
    pub margin_change_commitments: Vec<String>,
    pub market_id: String,
    pub match_transcript_digest: String,
    pub new_commitments: Vec<String>,
    pub new_root: String,
    pub old_root: String,
    pub open_interest_delta: String,
    pub order_updates: Vec<OrderUpdate>,
    pub residual_size: String,
    pub settlement_digest: String,
    pub spent_nullifiers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrderUpdate {
    pub intent_commitment: String,
    pub residual_commitment: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct ProvedSettlement {
    pub draft: SettlementDraft,
    pub journal: Vec<u8>,
    pub journal_digest: String,
}

#[derive(Clone)]
struct BookOrder {
    allocated_margin: u128,
    filled: u128,
    intent: RecoveredIntent,
    limit_price: u128,
    margin: u128,
    remaining: u128,
    sequence: usize,
    side: Side,
    size: u128,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Side {
    Long,
    Short,
}

#[derive(Clone)]
struct Fill {
    intent_commitment: String,
    margin: u128,
    market_id: String,
    owner_commitment: String,
    position_commitment: String,
    position_nullifier: String,
    price: u128,
    side: Side,
    size: u128,
}

struct Execution {
    long_intent_commitment: String,
    long_limit_price: u128,
    long_note_nullifier: String,
    long_position_commitment: String,
    maker_intent_commitment: String,
    maker_side: Side,
    price: u128,
    short_intent_commitment: String,
    short_limit_price: u128,
    short_note_nullifier: String,
    short_position_commitment: String,
    size: u128,
    taker_intent_commitment: String,
}

struct Residual {
    intent_commitment: String,
    limit_price: u128,
    margin: u128,
    market_id: String,
    note_nullifier: String,
    owner_commitment: String,
    signed_size: i128,
    source_intent_commitment: String,
}

struct MatchOutput {
    executions: Vec<Execution>,
    fills: Vec<Fill>,
    margin_change_commitments: Vec<String>,
    order_updates: Vec<OrderUpdate>,
    residuals: Vec<Residual>,
    spent_nullifiers: Vec<String>,
    aggregate_volume: u128,
    open_interest_delta: u128,
    residual_size: u128,
    total_long_size: u128,
    total_short_size: u128,
    match_transcript_digest: String,
}

pub fn prove_request(request: &ProofRequest) -> ProvedSettlement {
    let matched = match_batch(request);
    let fill_commitments = matched
        .fills
        .iter()
        .map(|fill| fill.position_commitment.clone())
        .collect::<Vec<_>>();
    let old_root = field_merkle_root(&request.position_commitments);
    assert_eq!(normalize_hex(&request.old_root), old_root, "old root mismatch");

    let mut new_leaves = request.position_commitments.clone();
    new_leaves.extend(fill_commitments.clone());
    let new_root = field_merkle_root(&new_leaves);
    assert_eq!(normalize_hex(&request.new_root), new_root, "new root mismatch");

    let settlement_digest = settlement_digest(
        &request.batch_id,
        &request.market.market_id,
        &request.old_root,
        &request.new_root,
        &matched,
    );
    let draft = SettlementDraft {
        aggregate_volume: matched.aggregate_volume.to_string(),
        batch_id: request.batch_id.clone(),
        fill_count: matched.fills.len() as u32,
        margin_change_commitments: matched.margin_change_commitments.clone(),
        market_id: request.market.market_id.clone(),
        match_transcript_digest: matched.match_transcript_digest.clone(),
        new_commitments: fill_commitments,
        new_root: normalize_hex(&request.new_root),
        old_root: normalize_hex(&request.old_root),
        open_interest_delta: matched.open_interest_delta.to_string(),
        order_updates: matched.order_updates.clone(),
        residual_size: matched.residual_size.to_string(),
        settlement_digest,
        spent_nullifiers: matched.spent_nullifiers.clone(),
    };

    assert_settlement(&draft, &request.expected);
    let journal = batch_public_input_bytes(&draft);
    let journal_digest = format!("0x{}", hex::encode(Sha256::digest(&journal)));

    ProvedSettlement {
        draft,
        journal,
        journal_digest,
    }
}

fn match_batch(request: &ProofRequest) -> MatchOutput {
    let mut orders = request
        .intents
        .iter()
        .enumerate()
        .map(|(sequence, intent)| to_book_order(intent.clone(), sequence))
        .collect::<Vec<_>>();
    reject_duplicate_nullifiers(&orders);

    let mut longs = orders
        .iter()
        .cloned()
        .filter(|order| order.side == Side::Long)
        .collect::<Vec<_>>();
    let mut shorts = orders
        .iter()
        .cloned()
        .filter(|order| order.side == Side::Short)
        .collect::<Vec<_>>();
    longs.sort_by(compare_long_priority);
    shorts.sort_by(compare_short_priority);

    let mut fills = Vec::new();
    let mut executions = Vec::new();
    let mut spent_nullifiers: Vec<String> = Vec::new();
    let mut long_index = 0usize;
    let mut short_index = 0usize;

    while long_index < longs.len() && short_index < shorts.len() {
        let long_limit = longs[long_index].limit_price;
        let short_limit = shorts[short_index].limit_price;
        if long_limit < short_limit {
            break;
        }

        let size = longs[long_index].remaining.min(shorts[short_index].remaining);
        let price = execution_price(&longs[long_index], &shorts[short_index]);
        let long_fill = create_fill(request, &mut longs[long_index], size, price, fills.len());
        let short_fill =
            create_fill(request, &mut shorts[short_index], size, price, fills.len() + 1);
        let execution = create_execution(&longs[long_index], &shorts[short_index], size, price, &long_fill, &short_fill);

        push_unique(&mut spent_nullifiers, longs[long_index].intent.note_nullifier.clone());
        push_unique(&mut spent_nullifiers, shorts[short_index].intent.note_nullifier.clone());
        fills.push(long_fill);
        fills.push(short_fill);
        executions.push(execution);

        longs[long_index].remaining -= size;
        shorts[short_index].remaining -= size;
        if longs[long_index].remaining == 0 {
            long_index += 1;
        }
        if shorts[short_index].remaining == 0 {
            short_index += 1;
        }
    }

    assert!(!fills.is_empty(), "batch has no crossed liquidity");

    for source in longs.into_iter().chain(shorts.into_iter()) {
        if let Some(order) = orders.iter_mut().find(|candidate| candidate.sequence == source.sequence) {
            order.filled = source.filled;
            order.allocated_margin = source.allocated_margin;
            order.remaining = source.remaining;
        }
    }

    let aggregate_volume = fills.iter().map(|fill| fill.size).sum::<u128>();
    let total_long_size = orders
        .iter()
        .filter(|order| order.side == Side::Long)
        .map(|order| order.size)
        .sum::<u128>();
    let total_short_size = orders
        .iter()
        .filter(|order| order.side == Side::Short)
        .map(|order| order.size)
        .sum::<u128>();
    let input_signed = total_long_size as i128 - total_short_size as i128;
    let filled_signed = fills.iter().fold(0i128, |sum, fill| {
        sum + if fill.side == Side::Long {
            fill.size as i128
        } else {
            -(fill.size as i128)
        }
    });
    let residual_signed = input_signed - filled_signed;
    let residual_size = residual_signed.unsigned_abs();

    let mut output = MatchOutput {
        executions,
        fills,
        margin_change_commitments: create_margin_change_commitments(&orders),
        order_updates: create_order_updates(&orders),
        residuals: create_residuals(request, &orders),
        spent_nullifiers,
        aggregate_volume,
        open_interest_delta: aggregate_volume,
        residual_size,
        total_long_size,
        total_short_size,
        match_transcript_digest: String::new(),
    };
    output.match_transcript_digest = match_transcript_digest(&output);
    output
}

fn to_book_order(intent: RecoveredIntent, sequence: usize) -> BookOrder {
    let signed_size = parse_i128(&intent.signed_size);
    let side = if signed_size >= 0 { Side::Long } else { Side::Short };
    let size = signed_size.unsigned_abs();
    let limit_price = parse_u128(&intent.limit_price);
    let margin = parse_u128(&intent.margin);

    assert!(size > 0, "intent size cannot be zero");
    assert!(limit_price > 0, "intent limit price must be positive");
    assert!(margin > 0, "intent margin must be positive");

    BookOrder {
        allocated_margin: 0,
        filled: 0,
        intent,
        limit_price,
        margin,
        remaining: size,
        sequence,
        side,
        size,
    }
}

fn compare_long_priority(a: &BookOrder, b: &BookOrder) -> core::cmp::Ordering {
    b.limit_price
        .cmp(&a.limit_price)
        .then_with(|| a.sequence.cmp(&b.sequence))
}

fn compare_short_priority(a: &BookOrder, b: &BookOrder) -> core::cmp::Ordering {
    a.limit_price
        .cmp(&b.limit_price)
        .then_with(|| a.sequence.cmp(&b.sequence))
}

fn execution_price(long: &BookOrder, short: &BookOrder) -> u128 {
    if long.sequence <= short.sequence {
        long.limit_price
    } else {
        short.limit_price
    }
}

fn create_fill(
    request: &ProofRequest,
    order: &mut BookOrder,
    size: u128,
    price: u128,
    fill_index: usize,
) -> Fill {
    let margin = allocate_margin(order, size);
    assert!(
        has_initial_margin(size, price, margin, parse_u128(&request.market.initial_margin_rate)),
        "insufficient initial margin"
    );
    assert!(
        has_max_leverage(size, price, margin, parse_u128(&request.market.max_leverage)),
        "max leverage exceeded"
    );

    let rho = format!("{}:position:{}", order.intent.intent_commitment, fill_index);
    let blinding_raw = format!("{}:blinding:{}", order.intent.intent_commitment, fill_index);
    let market_digest = digest_to_field_hex(&format!("market:{}", order.intent.market_id));
    let owner_digest = digest_to_field_hex(&format!("owner:{}", order.intent.owner_commitment));
    let rho_digest = digest_to_field_hex(&format!("rho:{rho}"));
    let blinding = digest_to_field_hex(&format!("blinding:{blinding_raw}"));
    let spend_secret_digest = digest_to_field_hex(&format!(
        "spend:{}:{}",
        order.intent.owner_commitment, rho
    ));
    let position_commitment = circuit_position_commitment(
        &market_digest,
        order.side,
        size,
        price,
        margin,
        parse_u128(&request.market.funding_index),
        &owner_digest,
        &rho_digest,
        &blinding,
    );
    let position_nullifier = field_hash_pair(&spend_secret_digest, &rho_digest);

    Fill {
        intent_commitment: order.intent.intent_commitment.clone(),
        margin,
        market_id: order.intent.market_id.clone(),
        owner_commitment: order.intent.owner_commitment.clone(),
        position_commitment,
        position_nullifier,
        price,
        side: order.side,
        size,
    }
}

fn allocate_margin(order: &mut BookOrder, fill_size: u128) -> u128 {
    let next_filled = order.filled + fill_size;
    let next_allocated = ceil_div(order.margin * next_filled, order.size);
    let fill_margin = next_allocated - order.allocated_margin;
    order.filled = next_filled;
    order.allocated_margin = next_allocated;
    fill_margin
}

fn create_execution(
    long: &BookOrder,
    short: &BookOrder,
    size: u128,
    price: u128,
    long_fill: &Fill,
    short_fill: &Fill,
) -> Execution {
    let maker = if long.sequence <= short.sequence { long } else { short };
    let taker = if maker.sequence == long.sequence { short } else { long };
    Execution {
        long_intent_commitment: long.intent.intent_commitment.clone(),
        long_limit_price: long.limit_price,
        long_note_nullifier: long.intent.note_nullifier.clone(),
        long_position_commitment: long_fill.position_commitment.clone(),
        maker_intent_commitment: maker.intent.intent_commitment.clone(),
        maker_side: maker.side,
        price,
        short_intent_commitment: short.intent.intent_commitment.clone(),
        short_limit_price: short.limit_price,
        short_note_nullifier: short.intent.note_nullifier.clone(),
        short_position_commitment: short_fill.position_commitment.clone(),
        size,
        taker_intent_commitment: taker.intent.intent_commitment.clone(),
    }
}

fn create_order_updates(orders: &[BookOrder]) -> Vec<OrderUpdate> {
    orders
        .iter()
        .filter(|order| order.filled > 0)
        .map(|order| OrderUpdate {
            intent_commitment: order.intent.intent_commitment.clone(),
            residual_commitment: if order.remaining > 0 {
                Some(residual_commitment(order))
            } else {
                None
            },
            status: if order.remaining > 0 {
                "partially-filled".to_string()
            } else {
                "filled".to_string()
            },
        })
        .collect()
}

fn create_residuals(request: &ProofRequest, orders: &[BookOrder]) -> Vec<Residual> {
    orders
        .iter()
        .filter(|order| order.filled > 0 && order.remaining > 0)
        .map(|order| {
            let margin = order.margin - order.allocated_margin;
            assert!(margin > 0, "invalid residual margin");
            Residual {
                intent_commitment: residual_commitment(order),
                limit_price: order.limit_price,
                margin,
                market_id: request.market.market_id.clone(),
                note_nullifier: residual_nullifier(order),
                owner_commitment: order.intent.owner_commitment.clone(),
                signed_size: if order.side == Side::Long {
                    order.remaining as i128
                } else {
                    -(order.remaining as i128)
                },
                source_intent_commitment: order.intent.intent_commitment.clone(),
            }
        })
        .collect()
}

fn create_margin_change_commitments(orders: &[BookOrder]) -> Vec<String> {
    let mut commitments = orders
        .iter()
        .filter(|order| order.filled > 0 && order.remaining > 0)
        .map(|order| {
            let remaining_margin = order.margin - order.allocated_margin;
            assert!(remaining_margin > 0, "invalid margin change");
            hash_fields(
                "margin-note",
                &[
                    Norm::text("usdc"),
                    Norm::num(remaining_margin),
                    Norm::text(&order.intent.owner_commitment),
                    Norm::text(format!(
                        "{}:margin-change:{}",
                        order.intent.intent_commitment, order.filled
                    )),
                    Norm::text(format!(
                        "{}:margin-change-blinding:{}",
                        order.intent.intent_commitment, order.remaining
                    )),
                ],
            )
        })
        .collect::<Vec<_>>();
    commitments.extend(
        orders
            .iter()
            .filter(|order| order.filled > 0 && order.intent.note_change_commitment != "0x0")
            .map(|order| order.intent.note_change_commitment.clone()),
    );
    commitments
}

fn residual_commitment(order: &BookOrder) -> String {
    hash_fields(
        "residual-order",
        &[
            Norm::text(&order.intent.intent_commitment),
            Norm::num(order.filled),
            Norm::num(order.allocated_margin),
        ],
    )
}

fn residual_nullifier(order: &BookOrder) -> String {
    hash_fields(
        "residual-nullifier",
        &[
            Norm::text(&order.intent.intent_commitment),
            Norm::num(order.filled),
            Norm::num(order.remaining),
            Norm::num(order.allocated_margin),
        ],
    )
}

fn match_transcript_digest(output: &MatchOutput) -> String {
    hash_fields(
        "match-transcript",
        &[
            Norm::Array(
                output
                    .executions
                    .iter()
                    .map(|execution| {
                        Norm::Array(vec![
                            Norm::text(&execution.long_intent_commitment),
                            Norm::num(execution.long_limit_price),
                            Norm::text(&execution.long_note_nullifier),
                            Norm::text(&execution.long_position_commitment),
                            Norm::text(&execution.maker_intent_commitment),
                            Norm::text(side_str(execution.maker_side)),
                            Norm::num(execution.price),
                            Norm::text(&execution.short_intent_commitment),
                            Norm::num(execution.short_limit_price),
                            Norm::text(&execution.short_note_nullifier),
                            Norm::text(&execution.short_position_commitment),
                            Norm::num(execution.size),
                            Norm::text(&execution.taker_intent_commitment),
                        ])
                    })
                    .collect(),
            ),
            Norm::Array(
                output
                    .fills
                    .iter()
                    .map(|fill| {
                        Norm::Array(vec![
                            Norm::text(&fill.intent_commitment),
                            Norm::text(&fill.market_id),
                            Norm::text(&fill.owner_commitment),
                            Norm::text(side_str(fill.side)),
                            Norm::num(fill.size),
                            Norm::num(fill.price),
                            Norm::num(fill.margin),
                            Norm::text(&fill.position_commitment),
                            Norm::text(&fill.position_nullifier),
                        ])
                    })
                    .collect(),
            ),
            Norm::Array(output.margin_change_commitments.iter().map(|value| Norm::text(value.as_str())).collect()),
            Norm::Array(
                output
                    .order_updates
                    .iter()
                    .map(|update| {
                        Norm::Array(vec![
                            Norm::text(&update.intent_commitment),
                            Norm::text(update.residual_commitment.as_deref().unwrap_or("0x0")),
                            Norm::text(&update.status),
                        ])
                    })
                    .collect(),
            ),
            Norm::Array(
                output
                    .residuals
                    .iter()
                    .map(|residual| {
                        Norm::Array(vec![
                            Norm::text(&residual.intent_commitment),
                            Norm::text(&residual.market_id),
                            Norm::text(&residual.owner_commitment),
                            Norm::i128(residual.signed_size),
                            Norm::num(residual.limit_price),
                            Norm::num(residual.margin),
                            Norm::text(&residual.note_nullifier),
                            Norm::text(&residual.source_intent_commitment),
                        ])
                    })
                    .collect(),
            ),
            Norm::Array(output.spent_nullifiers.iter().map(|value| Norm::text(value.as_str())).collect()),
            Norm::num(output.aggregate_volume),
            Norm::num(output.open_interest_delta),
            Norm::num(output.residual_size),
            Norm::num(output.total_long_size),
            Norm::num(output.total_short_size),
        ],
    )
}

fn settlement_digest(
    batch_id: &str,
    market_id: &str,
    old_root: &str,
    new_root: &str,
    output: &MatchOutput,
) -> String {
    hash_fields(
        "risc0-settlement",
        &[
            Norm::text(batch_id),
            Norm::text(market_id),
            Norm::text(normalize_hex(old_root)),
            Norm::text(normalize_hex(new_root)),
            Norm::text(&output.match_transcript_digest),
            Norm::Array(output.order_updates.iter().map(order_update_norm).collect()),
            Norm::Array(output.fills.iter().map(|fill| Norm::text(&fill.position_commitment)).collect()),
            Norm::Array(output.margin_change_commitments.iter().map(|value| Norm::text(value.as_str())).collect()),
            Norm::Array(output.spent_nullifiers.iter().map(|value| Norm::text(value.as_str())).collect()),
            Norm::num(output.aggregate_volume),
            Norm::num(output.open_interest_delta),
            Norm::num(output.residual_size),
        ],
    )
}

fn order_update_norm(update: &OrderUpdate) -> Norm {
    let mut entries = vec![
        ("intentCommitment".to_string(), Norm::text(&update.intent_commitment)),
        ("status".to_string(), Norm::text(&update.status)),
    ];
    if let Some(residual) = &update.residual_commitment {
        entries.push(("residualCommitment".to_string(), Norm::text(residual)));
    }
    Norm::Object(entries)
}

fn batch_public_input_bytes(draft: &SettlementDraft) -> Vec<u8> {
    let mut out = Vec::new();
    append_field(&mut out, &hash_fields("batch-id", &[Norm::text(&draft.batch_id)]));
    append_field(&mut out, &hash_fields("market-id", &[Norm::text(&draft.market_id)]));
    append_field(&mut out, &draft.old_root);
    append_field(&mut out, &draft.new_root);
    append_field(&mut out, &draft.settlement_digest);
    append_public_vec(
        &mut out,
        &draft
            .order_updates
            .iter()
            .map(|update| update.intent_commitment.clone())
            .collect::<Vec<_>>(),
    );
    append_public_vec(&mut out, &draft.new_commitments);
    append_public_vec(&mut out, &draft.margin_change_commitments);
    append_public_vec(&mut out, &draft.spent_nullifiers);
    append_u128(&mut out, parse_u128(&draft.residual_size));
    append_u128(&mut out, parse_u128(&draft.aggregate_volume));
    out
}

fn append_public_vec(out: &mut Vec<u8>, values: &[String]) {
    assert!(
        values.len() <= MAX_PUBLIC_ITEMS,
        "batch proof supports at most 8 public items"
    );
    append_u128(out, values.len() as u128);
    for value in values {
        append_field(out, value);
    }
    for _ in values.len()..MAX_PUBLIC_ITEMS {
        append_field(out, "0x0");
    }
}

fn append_field(out: &mut Vec<u8>, value: &str) {
    append_bytes32(out, &to_field_biguint(value));
}

fn append_u128(out: &mut Vec<u8>, value: u128) {
    append_bytes32(out, &BigUint::from(value));
}

fn append_bytes32(out: &mut Vec<u8>, value: &BigUint) {
    let mut bytes = value.to_bytes_be();
    assert!(bytes.len() <= 32, "field value out of range");
    out.extend(core::iter::repeat(0).take(32 - bytes.len()));
    out.append(&mut bytes);
}

fn assert_settlement(actual: &SettlementDraft, expected: &SettlementDraft) {
    assert_eq!(actual.aggregate_volume, expected.aggregate_volume);
    assert_eq!(actual.batch_id, expected.batch_id);
    assert_eq!(actual.fill_count, expected.fill_count);
    assert_eq!(actual.margin_change_commitments, expected.margin_change_commitments);
    assert_eq!(actual.market_id, expected.market_id);
    assert_eq!(actual.match_transcript_digest, expected.match_transcript_digest);
    assert_eq!(actual.new_commitments, expected.new_commitments);
    assert_eq!(actual.new_root, normalize_hex(&expected.new_root));
    assert_eq!(actual.old_root, normalize_hex(&expected.old_root));
    assert_eq!(actual.open_interest_delta, expected.open_interest_delta);
    assert_eq!(actual.order_updates, expected.order_updates);
    assert_eq!(actual.residual_size, expected.residual_size);
    assert_eq!(actual.settlement_digest, expected.settlement_digest);
    assert_eq!(actual.spent_nullifiers, expected.spent_nullifiers);
}

fn has_initial_margin(size: u128, price: u128, margin: u128, initial_rate: u128) -> bool {
    margin >= (notional(size, price) * initial_rate) / RATE_SCALE
}

fn has_max_leverage(size: u128, price: u128, margin: u128, max_leverage: u128) -> bool {
    margin > 0 && max_leverage > 0 && notional(size, price) <= margin * max_leverage
}

fn notional(size: u128, price: u128) -> u128 {
    (size * price) / PRICE_SCALE
}

fn circuit_position_commitment(
    market_digest: &str,
    side: Side,
    size: u128,
    entry_price: u128,
    margin: u128,
    funding_index: u128,
    owner_digest: &str,
    rho_digest: &str,
    blinding: &str,
) -> String {
    let side_value = if side == Side::Long { "1" } else { "2" };
    let left = field_hash_pair(
        &field_hash_pair(market_digest, side_value),
        &field_hash_pair(&size.to_string(), &entry_price.to_string()),
    );
    let right = field_hash_pair(
        &field_hash_pair(&margin.to_string(), &funding_index.to_string()),
        &field_hash_pair(owner_digest, &field_hash_pair(rho_digest, blinding)),
    );
    field_hash_pair(&left, &right)
}

fn field_merkle_root(leaves: &[String]) -> String {
    let width = 1usize << FIELD_MERKLE_DEPTH;
    assert!(leaves.len() <= width, "field merkle tree is full");
    let mut current = leaves.iter().map(|leaf| field_hex(to_field_biguint(leaf))).collect::<Vec<_>>();
    current.sort();
    while current.len() < width {
        current.push(field_hex(BigUint::zero()));
    }
    for _ in 0..FIELD_MERKLE_DEPTH {
        let mut next = Vec::with_capacity(current.len() / 2);
        for pair in current.chunks_exact(2) {
            next.push(field_hash_pair(&pair[0], &pair[1]));
        }
        current = next;
    }
    current[0].clone()
}

fn field_hash_pair(left: &str, right: &str) -> String {
    let prime = field_prime();
    let value = (to_field_biguint(left) * LEFT_FACTOR
        + to_field_biguint(right) * RIGHT_FACTOR
        + BigUint::from(DOMAIN_FACTOR))
        % prime;
    field_hex(value)
}

fn digest_to_field_hex(input: &str) -> String {
    field_hex(BigUint::from_bytes_be(&Sha256::digest(input.as_bytes())) % field_prime())
}

fn field_hex(value: BigUint) -> String {
    format!("0x{:0>64}", value.to_str_radix(16))
}

fn to_field_biguint(value: &str) -> BigUint {
    let prime = field_prime();
    parse_bigint(value).mod_floor(&BigInt::from(prime)).to_biguint().unwrap()
}

trait ModFloor {
    fn mod_floor(&self, modulus: &BigInt) -> BigInt;
}

impl ModFloor for BigInt {
    fn mod_floor(&self, modulus: &BigInt) -> BigInt {
        let out = self % modulus;
        if out < BigInt::zero() {
            out + modulus
        } else {
            out
        }
    }
}

fn parse_bigint(value: &str) -> BigInt {
    let trimmed = value.trim();
    if let Some(hex) = trimmed.strip_prefix("0x") {
        BigInt::parse_bytes(hex.as_bytes(), 16).unwrap_or_else(|| panic!("invalid hex: {value}"))
    } else {
        BigInt::parse_bytes(trimmed.as_bytes(), 10).unwrap_or_else(|| panic!("invalid integer: {value}"))
    }
}

fn field_prime() -> BigUint {
    BigUint::parse_bytes(FIELD_PRIME_DEC.as_bytes(), 10).unwrap()
}

fn hash_fields(domain: &str, fields: &[Norm]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"pnlx:");
    hash.update(domain.as_bytes());
    hash.update(b":");
    hash.update(
        fields
            .iter()
            .map(Norm::normalize)
            .collect::<Vec<_>>()
            .join("|")
            .as_bytes(),
    );
    format!("0x{}", hex::encode(hash.finalize()))
}

enum Norm {
    Array(Vec<Norm>),
    I128(i128),
    Num(u128),
    Object(Vec<(String, Norm)>),
    Text(String),
}

impl Norm {
    fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    fn num(value: u128) -> Self {
        Self::Num(value)
    }

    fn i128(value: i128) -> Self {
        Self::I128(value)
    }

    fn normalize(&self) -> String {
        match self {
            Self::Array(items) => format!(
                "[{}]",
                items.iter().map(Self::normalize).collect::<Vec<_>>().join(",")
            ),
            Self::I128(value) => value.to_string(),
            Self::Num(value) => value.to_string(),
            Self::Object(entries) => {
                let mut sorted = entries.iter().collect::<Vec<_>>();
                sorted.sort_by(|(left, _), (right, _)| left.cmp(right));
                format!(
                    "{{{}}}",
                    sorted
                        .into_iter()
                        .map(|(key, value)| format!("{key}:{}", value.normalize()))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            Self::Text(value) => value.clone(),
        }
    }
}

fn normalize_hex(value: &str) -> String {
    if value == "0x0" {
        return "0x0".to_string();
    }
    if let Some(hex) = value.strip_prefix("0x") {
        format!("0x{}", hex.to_lowercase())
    } else {
        value.to_string()
    }
}

fn parse_u128(value: &str) -> u128 {
    value.parse::<u128>().unwrap_or_else(|_| panic!("invalid u128: {value}"))
}

fn parse_i128(value: &str) -> i128 {
    value.parse::<i128>().unwrap_or_else(|_| panic!("invalid i128: {value}"))
}

fn side_str(side: Side) -> &'static str {
    match side {
        Side::Long => "long",
        Side::Short => "short",
    }
}

fn ceil_div(value: u128, divisor: u128) -> u128 {
    (value + divisor - 1) / divisor
}

fn reject_duplicate_nullifiers(orders: &[BookOrder]) {
    let mut seen = Vec::<String>::new();
    for order in orders {
        assert!(
            !seen.contains(&order.intent.note_nullifier),
            "duplicate intent nullifier"
        );
        seen.push(order.intent.note_nullifier.clone());
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}
