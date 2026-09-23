use num_bigint::{BigInt, BigUint};
use num_traits::Zero;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FIELD_PRIME_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const LEFT_FACTOR: u32 = 131;
const RIGHT_FACTOR: u32 = 137;
const DOMAIN_FACTOR: u32 = 17;
const PRICE_SCALE: u128 = 100_000_000;
const RATE_SCALE: u128 = 1_000_000;
const TAKER_FEE_PPM: u128 = 500;
const MAKER_REBATE_PPM: u128 = 150;
const INSURANCE_FEE_PPM: u128 = 100;
const FEE_EPOCH: u128 = 1;
const MAX_PUBLIC_ITEMS: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProofRequest {
    pub batch_id: String,
    pub intents: Vec<RecoveredIntent>,
    pub market: MarketInput,
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
    pub fee_config_hash: String,
    pub gross_taker_fee: String,
    pub maker_rebate: String,
    pub insurance_fee: String,
    pub treasury_fee: String,
    pub maker_intents: Vec<String>,
    pub taker_intents: Vec<String>,
    pub margin_change_commitments: Vec<String>,
    pub matching_payload_commitments: Vec<String>,
    pub residual_commitments: Vec<String>,
    pub residual_margins: Vec<String>,
    pub residual_payload_commitments: Vec<String>,
    pub market_id: String,
    pub match_transcript_digest: String,
    pub new_commitments: Vec<String>,
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
    gross_taker_fee: u128,
    maker_rebate: u128,
    insurance: u128,
    treasury: u128,
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
    fees: FillFees,
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

#[derive(Clone, Copy, Default)]
struct FillFees {
    gross_taker_fee: u128,
    maker_rebate: u128,
    insurance: u128,
    treasury: u128,
}

fn fill_fees(size: u128, price: u128) -> FillFees {
    let value = notional(size, price);
    let gross_taker_fee = value * TAKER_FEE_PPM / RATE_SCALE;
    let maker_rebate = value * MAKER_REBATE_PPM / RATE_SCALE;
    let insurance = value * INSURANCE_FEE_PPM / RATE_SCALE;
    FillFees {
        gross_taker_fee,
        maker_rebate,
        insurance,
        treasury: gross_taker_fee - maker_rebate - insurance,
    }
}

pub fn prove_request(request: &ProofRequest) -> ProvedSettlement {
    let matched = match_batch(request);
    let fill_commitments = matched
        .fills
        .iter()
        .map(|fill| fill.position_commitment.clone())
        .collect::<Vec<_>>();
    let settlement_digest =
        settlement_digest(&request.batch_id, &request.market.market_id, &matched);
    let matching_payload_commitments = matched
        .order_updates
        .iter()
        .map(|update| {
            let intent = request
                .intents
                .iter()
                .find(|intent| intent.intent_commitment == update.intent_commitment)
                .expect("filled intent payload missing");
            matching_payload_commitment(intent)
        })
        .collect();
    let residual_commitments = matched
        .order_updates
        .iter()
        .map(|update| {
            update
                .residual_commitment
                .clone()
                .unwrap_or_else(|| "0x0".to_string())
        })
        .collect();
    let residual_payload_commitments = matched
        .order_updates
        .iter()
        .map(|update| {
            matched
                .residuals
                .iter()
                .find(|residual| residual.source_intent_commitment == update.intent_commitment)
                .map(residual_payload_commitment)
                .unwrap_or_else(|| "0x0".to_string())
        })
        .collect();
    let residual_margins = matched
        .order_updates
        .iter()
        .map(|update| {
            matched
                .residuals
                .iter()
                .find(|residual| residual.source_intent_commitment == update.intent_commitment)
                .map(|residual| residual.margin.to_string())
                .unwrap_or_else(|| "0".to_string())
        })
        .collect();
    let draft = SettlementDraft {
        aggregate_volume: matched.aggregate_volume.to_string(),
        batch_id: request.batch_id.clone(),
        fill_count: matched.fills.len() as u32,
        fee_config_hash: fee_config_hash(),
        gross_taker_fee: matched.fees.gross_taker_fee.to_string(),
        maker_rebate: matched.fees.maker_rebate.to_string(),
        insurance_fee: matched.fees.insurance.to_string(),
        treasury_fee: matched.fees.treasury.to_string(),
        maker_intents: matched
            .executions
            .iter()
            .map(|execution| execution.maker_intent_commitment.clone())
            .collect(),
        taker_intents: matched
            .executions
            .iter()
            .map(|execution| execution.taker_intent_commitment.clone())
            .collect(),
        margin_change_commitments: matched.margin_change_commitments.clone(),
        matching_payload_commitments,
        residual_commitments,
        residual_margins,
        residual_payload_commitments,
        market_id: request.market.market_id.clone(),
        match_transcript_digest: matched.match_transcript_digest.clone(),
        new_commitments: fill_commitments,
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

        let size = longs[long_index]
            .remaining
            .min(shorts[short_index].remaining);
        let price = execution_price(&longs[long_index], &shorts[short_index]);
        let fees = fill_fees(size, price);
        let long_maker = longs[long_index].sequence <= shorts[short_index].sequence;
        let long_delta = if long_maker {
            fees.maker_rebate as i128
        } else {
            -(fees.gross_taker_fee as i128)
        };
        let short_delta = if long_maker {
            -(fees.gross_taker_fee as i128)
        } else {
            fees.maker_rebate as i128
        };
        let long_fill = create_fill(
            request,
            &mut longs[long_index],
            size,
            price,
            fills.len(),
            long_delta,
        );
        let short_fill = create_fill(
            request,
            &mut shorts[short_index],
            size,
            price,
            fills.len() + 1,
            short_delta,
        );
        let execution = create_execution(
            &longs[long_index],
            &shorts[short_index],
            size,
            price,
            &long_fill,
            &short_fill,
            fees,
        );

        push_unique(
            &mut spent_nullifiers,
            longs[long_index].intent.note_nullifier.clone(),
        );
        push_unique(
            &mut spent_nullifiers,
            shorts[short_index].intent.note_nullifier.clone(),
        );
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
        if let Some(order) = orders
            .iter_mut()
            .find(|candidate| candidate.sequence == source.sequence)
        {
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
        fees: FillFees::default(),
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
    for execution in &output.executions {
        output.fees.gross_taker_fee += execution.gross_taker_fee;
        output.fees.maker_rebate += execution.maker_rebate;
        output.fees.insurance += execution.insurance;
        output.fees.treasury += execution.treasury;
    }
    output.match_transcript_digest = match_transcript_digest(&output);
    output
}

fn to_book_order(intent: RecoveredIntent, sequence: usize) -> BookOrder {
    let signed_size = parse_i128(&intent.signed_size);
    let side = if signed_size >= 0 {
        Side::Long
    } else {
        Side::Short
    };
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
    fee_delta: i128,
) -> Fill {
    let allocated_margin = allocate_margin(order, size);
    let margin = if fee_delta < 0 {
        allocated_margin
            .checked_sub(fee_delta.unsigned_abs())
            .expect("fee exceeds allocated margin")
    } else {
        allocated_margin
            .checked_add(fee_delta as u128)
            .expect("fee margin overflow")
    };
    assert!(
        has_initial_margin(
            size,
            price,
            margin,
            parse_u128(&request.market.initial_margin_rate)
        ),
        "insufficient initial margin"
    );
    assert!(
        has_max_leverage(
            size,
            price,
            margin,
            parse_u128(&request.market.max_leverage)
        ),
        "max leverage exceeded"
    );

    let rho = format!("{}:position:{}", order.intent.intent_commitment, fill_index);
    let blinding_raw = format!("{}:blinding:{}", order.intent.intent_commitment, fill_index);
    let market_digest = digest_to_field_hex(&format!("market:{}", order.intent.market_id));
    let owner_digest = digest_to_field_hex(&format!("owner:{}", order.intent.owner_commitment));
    let rho_digest = digest_to_field_hex(&format!("rho:{rho}"));
    let blinding = digest_to_field_hex(&format!("blinding:{blinding_raw}"));
    let spend_secret_digest =
        digest_to_field_hex(&format!("spend:{}:{}", order.intent.owner_commitment, rho));
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
    fees: FillFees,
) -> Execution {
    let maker = if long.sequence <= short.sequence {
        long
    } else {
        short
    };
    let taker = if maker.sequence == long.sequence {
        short
    } else {
        long
    };
    Execution {
        gross_taker_fee: fees.gross_taker_fee,
        maker_rebate: fees.maker_rebate,
        insurance: fees.insurance,
        treasury: fees.treasury,
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
    orders
        .iter()
        .filter(|order| order.filled > 0 && order.intent.note_change_commitment != "0x0")
        .map(|order| order.intent.note_change_commitment.clone())
        .collect()
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
                            Norm::num(execution.gross_taker_fee),
                            Norm::num(execution.maker_rebate),
                            Norm::num(execution.insurance),
                            Norm::num(execution.treasury),
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
            Norm::Array(vec![
                Norm::num(output.fees.gross_taker_fee),
                Norm::num(output.fees.maker_rebate),
                Norm::num(output.fees.insurance),
                Norm::num(output.fees.treasury),
            ]),
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
            Norm::Array(
                output
                    .margin_change_commitments
                    .iter()
                    .map(|value| Norm::text(value.as_str()))
                    .collect(),
            ),
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
            Norm::Array(
                output
                    .spent_nullifiers
                    .iter()
                    .map(|value| Norm::text(value.as_str()))
                    .collect(),
            ),
            Norm::num(output.aggregate_volume),
            Norm::num(output.open_interest_delta),
            Norm::num(output.residual_size),
            Norm::num(output.total_long_size),
            Norm::num(output.total_short_size),
        ],
    )
}

fn settlement_digest(batch_id: &str, market_id: &str, output: &MatchOutput) -> String {
    hash_fields(
        "risc0-settlement",
        &[
            Norm::text(batch_id),
            Norm::text(market_id),
            Norm::text(&output.match_transcript_digest),
            Norm::Array(output.order_updates.iter().map(order_update_norm).collect()),
            Norm::Array(
                output
                    .fills
                    .iter()
                    .map(|fill| Norm::text(&fill.position_commitment))
                    .collect(),
            ),
            Norm::Array(
                output
                    .margin_change_commitments
                    .iter()
                    .map(|value| Norm::text(value.as_str()))
                    .collect(),
            ),
            Norm::Array(
                output
                    .spent_nullifiers
                    .iter()
                    .map(|value| Norm::text(value.as_str()))
                    .collect(),
            ),
            Norm::num(output.aggregate_volume),
            Norm::num(output.open_interest_delta),
            Norm::num(output.residual_size),
        ],
    )
}

fn order_update_norm(update: &OrderUpdate) -> Norm {
    let mut entries = vec![
        (
            "intentCommitment".to_string(),
            Norm::text(&update.intent_commitment),
        ),
        ("status".to_string(), Norm::text(&update.status)),
    ];
    if let Some(residual) = &update.residual_commitment {
        entries.push(("residualCommitment".to_string(), Norm::text(residual)));
    }
    Norm::Object(entries)
}

fn batch_public_input_bytes(draft: &SettlementDraft) -> Vec<u8> {
    let mut out = Vec::new();
    append_field(
        &mut out,
        &hash_fields("batch-id", &[Norm::text(&draft.batch_id)]),
    );
    append_field(
        &mut out,
        &hash_fields("market-id", &[Norm::text(&draft.market_id)]),
    );
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
    append_public_vec(&mut out, &draft.matching_payload_commitments);
    append_public_vec(&mut out, &draft.residual_commitments);
    append_public_amounts(&mut out, &draft.residual_margins);
    append_public_vec(&mut out, &draft.residual_payload_commitments);
    append_u128(&mut out, parse_u128(&draft.residual_size));
    append_u128(&mut out, parse_u128(&draft.aggregate_volume));
    append_field(&mut out, &draft.fee_config_hash);
    append_u128(&mut out, parse_u128(&draft.gross_taker_fee));
    append_u128(&mut out, parse_u128(&draft.maker_rebate));
    append_u128(&mut out, parse_u128(&draft.insurance_fee));
    append_u128(&mut out, parse_u128(&draft.treasury_fee));
    append_public_vec(&mut out, &draft.maker_intents);
    append_public_vec(&mut out, &draft.taker_intents);
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

fn append_public_amounts(out: &mut Vec<u8>, values: &[String]) {
    assert!(
        values.len() <= MAX_PUBLIC_ITEMS,
        "batch proof supports at most 8 public items"
    );
    append_u128(out, values.len() as u128);
    for value in values {
        append_u128(out, parse_u128(value));
    }
    for _ in values.len()..MAX_PUBLIC_ITEMS {
        append_u128(out, 0);
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
    assert_eq!(actual.fee_config_hash, expected.fee_config_hash);
    assert_eq!(actual.gross_taker_fee, expected.gross_taker_fee);
    assert_eq!(actual.maker_rebate, expected.maker_rebate);
    assert_eq!(actual.insurance_fee, expected.insurance_fee);
    assert_eq!(actual.treasury_fee, expected.treasury_fee);
    assert_eq!(actual.maker_intents, expected.maker_intents);
    assert_eq!(actual.taker_intents, expected.taker_intents);
    assert_eq!(
        actual.margin_change_commitments,
        expected.margin_change_commitments
    );
    assert_eq!(
        actual.matching_payload_commitments,
        expected.matching_payload_commitments
    );
    assert_eq!(actual.residual_commitments, expected.residual_commitments);
    assert_eq!(actual.residual_margins, expected.residual_margins);
    assert_eq!(
        actual.residual_payload_commitments,
        expected.residual_payload_commitments
    );
    assert_eq!(actual.market_id, expected.market_id);
    assert_eq!(
        actual.match_transcript_digest,
        expected.match_transcript_digest
    );
    assert_eq!(actual.new_commitments, expected.new_commitments);
    assert_eq!(actual.open_interest_delta, expected.open_interest_delta);
    assert_eq!(actual.order_updates, expected.order_updates);
    assert_eq!(actual.residual_size, expected.residual_size);
    assert_eq!(actual.settlement_digest, expected.settlement_digest);
    assert_eq!(actual.spent_nullifiers, expected.spent_nullifiers);
}

fn fee_config_hash() -> String {
    let mut bytes = Vec::new();
    append_u128(&mut bytes, FEE_EPOCH);
    append_u128(&mut bytes, TAKER_FEE_PPM);
    append_u128(&mut bytes, MAKER_REBATE_PPM);
    append_u128(&mut bytes, INSURANCE_FEE_PPM);
    format!("0x{}", hex::encode(Sha256::digest(&bytes)))
}

#[cfg(test)]
mod fee_tests {
    use super::{fee_config_hash, fill_fees, prove_request, ProofRequest, PRICE_SCALE};

    #[test]
    fn matches_type_script_fee_configuration_and_base_unit_split() {
        assert_eq!(
            fee_config_hash(),
            "0xbb5f68bb955bd581f42275c73aa5063589736f55c733db22e05cf372dfedd687"
        );
        let fees = fill_fees(10_000_000_000, PRICE_SCALE);
        assert_eq!(fees.gross_taker_fee, 5_000_000);
        assert_eq!(fees.maker_rebate, 1_500_000);
        assert_eq!(fees.insurance, 1_000_000);
        assert_eq!(fees.treasury, 2_500_000);
    }

    #[test]
    fn proves_typescript_fee_match_fixture() {
        let request: ProofRequest =
            serde_json::from_str(include_str!("../tests/fixtures/fee-match.json"))
                .expect("valid cross-language proof request");
        let proved = prove_request(&request);
        assert_eq!(
            proved.journal_digest,
            "0x454bf8cc942884e428d8fa6f70fca5ca16eb0896da0d77c347c4fd81a769a15f"
        );
        assert_eq!(proved.draft.gross_taker_fee, "500000");
        assert_eq!(proved.draft.maker_rebate, "150000");
        assert_eq!(proved.draft.insurance_fee, "100000");
        assert_eq!(proved.draft.treasury_fee, "250000");
    }
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
    parse_bigint(value)
        .mod_floor(&BigInt::from(prime))
        .to_biguint()
        .unwrap()
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
        BigInt::parse_bytes(trimmed.as_bytes(), 10)
            .unwrap_or_else(|| panic!("invalid integer: {value}"))
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

fn matching_payload_commitment(intent: &RecoveredIntent) -> String {
    hash_fields(
        "matching-payload",
        &[
            Norm::text(&intent.intent_commitment),
            Norm::text(&intent.market_id),
            Norm::text(&intent.owner_commitment),
            Norm::I128(parse_i128(&intent.signed_size)),
            Norm::num(parse_u128(&intent.limit_price)),
            Norm::num(parse_u128(&intent.margin)),
            Norm::text(&intent.note_nullifier),
            Norm::text(&intent.note_change_commitment),
            Norm::text(intent.source_intent_commitment.as_deref().unwrap_or("0x0")),
        ],
    )
}

fn residual_payload_commitment(residual: &Residual) -> String {
    hash_fields(
        "matching-payload",
        &[
            Norm::text(&residual.intent_commitment),
            Norm::text(&residual.market_id),
            Norm::text(&residual.owner_commitment),
            Norm::I128(residual.signed_size),
            Norm::num(residual.limit_price),
            Norm::num(residual.margin),
            Norm::text(&residual.note_nullifier),
            Norm::text("0x0"),
            Norm::text(&residual.source_intent_commitment),
        ],
    )
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
                items
                    .iter()
                    .map(Self::normalize)
                    .collect::<Vec<_>>()
                    .join(",")
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

fn parse_u128(value: &str) -> u128 {
    value
        .parse::<u128>()
        .unwrap_or_else(|_| panic!("invalid u128: {value}"))
}

fn parse_i128(value: &str) -> i128 {
    value
        .parse::<i128>()
        .unwrap_or_else(|_| panic!("invalid i128: {value}"))
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
