use alloy::primitives::U256;
use anyhow::{Context, Result};
use boundless_market::contracts::{Predicate, ProofRequest, RequestStatus};
use risc0_zkvm::sha::Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};
use std::{fs, fs::File, io::Write, path::Path};

#[derive(Clone, Deserialize, Serialize)]
pub struct RequestJournal {
    pub expires_at: u64,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<ProofRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_price_usd_micro: Option<u64>,
}

#[derive(Debug, PartialEq)]
pub enum RecoveryAction {
    PublishOriginal,
    RecoverOriginal,
}

impl RequestJournal {
    pub fn prepared(request: ProofRequest, max_price_usd_micro: u64) -> Result<Self> {
        if request.id == U256::ZERO {
            anyhow::bail!("Boundless request ID must be saved before submission");
        }
        Ok(Self {
            expires_at: request.expires_at(),
            request_id: format!("0x{:x}", request.id),
            request: Some(request),
            submitted: Some(false),
            max_price_usd_micro: Some(max_price_usd_micro),
        })
    }

    pub fn id(&self) -> Result<U256> {
        let raw = self
            .request_id
            .strip_prefix("0x")
            .context("saved Boundless request ID must be hexadecimal")?;
        if raw.is_empty()
            || raw.len() > 64
            || !raw.bytes().all(|b| b.is_ascii_hexdigit())
            || self.expires_at == 0
        {
            anyhow::bail!("invalid saved Boundless request; reconciliation required");
        }
        let id = U256::from_str_radix(raw, 16).context("parse saved Boundless request ID")?;
        if id == U256::ZERO {
            anyhow::bail!("saved Boundless request ID cannot be zero");
        }
        Ok(id)
    }

    pub fn validate_binding(&self, image_id: Digest, journal: &[u8]) -> Result<()> {
        let id = self.id()?;
        if let Some(request) = &self.request {
            if request.id != id
                || request.expires_at() != self.expires_at
                || self.submitted.is_none()
                || self.max_price_usd_micro.is_none()
            {
                anyhow::bail!("saved Boundless request identity is inconsistent");
            }
            let digest = Digest::from(<[u8; 32]>::from(Sha256::digest(journal)));
            match Predicate::try_from(request.requirements.predicate.clone())? {
                Predicate::DigestMatch(saved_image, saved_journal)
                    if saved_image == image_id && saved_journal == digest => {}
                _ => {
                    anyhow::bail!("saved Boundless request belongs to a different proof statement")
                }
            }
        } else if self.submitted == Some(false) || self.max_price_usd_micro.is_some() {
            anyhow::bail!("prepared Boundless request payload is missing; reconciliation required");
        }
        Ok(())
    }

    pub fn action(&self, status: RequestStatus, current_max_price: u64) -> Result<RecoveryAction> {
        match status {
            RequestStatus::Expired => anyhow::bail!("original Boundless request expired without fulfillment; replacement payment is disabled"),
            RequestStatus::Unknown if self.submitted == Some(false) => {
                if self.request.is_none() || self.max_price_usd_micro.is_none_or(|price| price > current_max_price) {
                    anyhow::bail!("saved Boundless offer exceeds the current spending limit");
                }
                Ok(RecoveryAction::PublishOriginal)
            }
            _ => Ok(RecoveryAction::RecoverOriginal),
        }
    }
}

pub fn lock_job(directory: &Path) -> Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let mut options = File::options();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(directory.join("request.lock"))
        .context("open Boundless proof job lock")?;
    lock.try_lock()
        .context("Boundless proof job is already running")?;
    Ok(lock)
}

pub fn read(directory: &Path) -> Result<Option<RequestJournal>> {
    let path = directory.join("request.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("read saved Boundless request"),
    };
    let record: RequestJournal = serde_json::from_slice(&bytes)
        .context("invalid saved Boundless request; reconciliation required")?;
    record.id()?;
    Ok(Some(record))
}

pub fn write(directory: &Path, record: &RequestJournal) -> Result<()> {
    record.id()?;
    write_atomic(
        directory,
        "request.json",
        &serde_json::to_vec_pretty(record)?,
    )
}

pub fn write_atomic(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    let mut options = File::options();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .context("create durable Boundless journal temporary file")?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, directory.join(name)).context("publish durable Boundless journal")?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Directory(std::path::PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pnlx-boundless-journal-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (RequestJournal, Digest, Vec<u8>) {
        let image = Digest::from([1u8; 32]);
        let journal = b"original immutable batch journal".to_vec();
        let digest = Digest::from(<[u8; 32]>::from(Sha256::digest(&journal)));
        let request = ProofRequest {
            id: U256::from(1234),
            requirements: boundless_market::contracts::Requirements::new(Predicate::digest_match(
                image, digest,
            )),
            imageUrl: "https://example.invalid/program".into(),
            input: boundless_market::contracts::RequestInput::builder()
                .build_inline()
                .unwrap(),
            offer: boundless_market::contracts::Offer {
                minPrice: U256::ZERO,
                maxPrice: U256::from(1),
                rampUpStart: 100,
                timeout: 60,
                rampUpPeriod: 1,
                lockTimeout: 30,
                lockCollateral: U256::ZERO,
            },
        };
        (
            RequestJournal::prepared(request, 150_000).unwrap(),
            image,
            journal,
        )
    }

    #[test]
    fn a_lost_submission_response_reuses_the_persisted_request_and_offer() {
        let directory = Directory::new();
        let (saved, image, journal) = fixture();
        let original = serde_json::to_vec(saved.request.as_ref().unwrap()).unwrap();
        write(&directory.0, &saved).unwrap();
        let mut recovered = read(&directory.0).unwrap().unwrap();
        recovered.validate_binding(image, &journal).unwrap();
        assert_eq!(recovered.id().unwrap(), saved.id().unwrap());
        assert_eq!(
            serde_json::to_vec(recovered.request.as_ref().unwrap()).unwrap(),
            original
        );
        assert_eq!(
            recovered.action(RequestStatus::Unknown, 150_000).unwrap(),
            RecoveryAction::PublishOriginal
        );
        for status in [RequestStatus::Locked, RequestStatus::Fulfilled] {
            assert_eq!(
                recovered.action(status, 0).unwrap(),
                RecoveryAction::RecoverOriginal
            );
        }
        recovered.submitted = Some(true);
        write(&directory.0, &recovered).unwrap();
        let recovered = read(&directory.0).unwrap().unwrap();
        assert_eq!(
            recovered.action(RequestStatus::Unknown, 150_000).unwrap(),
            RecoveryAction::RecoverOriginal
        );
        assert_eq!(
            serde_json::to_vec(recovered.request.as_ref().unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn an_expired_fulfilled_request_is_recovered_without_authorizing_a_replacement() {
        let (saved, _, _) = fixture();
        assert_eq!(saved.expires_at, 160);
        assert_eq!(
            saved.action(RequestStatus::Fulfilled, 0).unwrap(),
            RecoveryAction::RecoverOriginal
        );
        assert!(saved.action(RequestStatus::Expired, 150_000).is_err());
        assert!(saved.action(RequestStatus::Unknown, 30_000).is_err());
    }

    #[test]
    fn changing_the_statement_or_request_identity_cannot_reuse_the_saved_job() {
        let (mut saved, image, journal) = fixture();
        saved.validate_binding(image, &journal).unwrap();
        assert!(saved
            .validate_binding(Digest::from([2u8; 32]), &journal)
            .is_err());
        assert!(saved
            .validate_binding(image, b"changed batch journal")
            .is_err());
        saved.request.as_mut().unwrap().id += U256::from(1);
        assert!(saved.validate_binding(image, &journal).is_err());
        let (mut saved, _, _) = fixture();
        saved.expires_at += 1;
        assert!(saved.validate_binding(image, &journal).is_err());
    }

    #[test]
    fn existing_legacy_requests_can_only_be_observed_and_recovered() {
        let directory = Directory::new();
        fs::write(
            directory.0.join("request.json"),
            br#"{"request_id":"0x1234","expires_at":1}"#,
        )
        .unwrap();
        let saved = read(&directory.0).unwrap().unwrap();
        saved
            .validate_binding(
                Digest::from([1u8; 32]),
                b"legacy output validated after retrieval",
            )
            .unwrap();
        assert_eq!(
            saved.action(RequestStatus::Unknown, 150_000).unwrap(),
            RecoveryAction::RecoverOriginal
        );
        assert_eq!(
            saved.action(RequestStatus::Fulfilled, 0).unwrap(),
            RecoveryAction::RecoverOriginal
        );
        assert!(saved.action(RequestStatus::Expired, 150_000).is_err());
    }

    #[test]
    fn damaged_metadata_never_becomes_a_new_job() {
        let directory = Directory::new();
        assert!(read(&directory.0).unwrap().is_none());
        for value in [
            "{",
            "null",
            "{}",
            r#"{"request_id":"0x0","expires_at":100}"#,
            r#"{"request_id":"0x1234","expires_at":0}"#,
        ] {
            fs::write(directory.0.join("request.json"), value).unwrap();
            assert!(read(&directory.0).is_err());
        }
        let (mut saved, image, journal) = fixture();
        saved.request = None;
        assert!(saved.validate_binding(image, &journal).is_err());
    }

    #[test]
    fn the_job_lock_releases_on_process_resource_loss_without_a_stale_marker() {
        let directory = Directory::new();
        let first = lock_job(&directory.0).unwrap();
        assert!(lock_job(&directory.0).is_err());
        drop(first);
        assert!(lock_job(&directory.0).is_ok());
        let (saved, _, _) = fixture();
        write(&directory.0, &saved).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.0.join("request.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
