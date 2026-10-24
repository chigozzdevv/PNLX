use anyhow::{bail, Context, Result};
use aws_config::{defaults, BehaviorVersion};
use aws_sdk_s3::{
    config::{Credentials, Region},
    types::PublicAccessBlockConfiguration,
    Client,
};
use boundless_market::{
    contracts::{RequestInput, RequestInputType},
    storage::{StorageUploaderConfig, StorageUploaderType},
};
use url::Url;

pub fn validate_config(config: &StorageUploaderConfig) -> Result<()> {
    if config.storage_uploader != StorageUploaderType::S3 {
        bail!("Batch witnesses require authenticated S3 storage");
    }
    if config.s3_presigned != Some(false) || config.s3_public_url == Some(true) {
        bail!("Batch witnesses require S3_PRESIGNED=false and S3_PUBLIC_URL=false");
    }
    if config
        .s3_bucket
        .as_deref()
        .is_none_or(|bucket| bucket.trim().is_empty())
    {
        bail!("S3_BUCKET is required for batch witnesses");
    }
    if config.s3_url.is_some() {
        bail!("Batch witness storage requires AWS S3 with verifiable public-access blocking");
    }
    Ok(())
}

pub async fn verify_bucket(config: &StorageUploaderConfig) -> Result<()> {
    validate_config(config)?;
    let mut loader = defaults(BehaviorVersion::latest());
    if let Some(region) = &config.aws_region {
        loader = loader.region(Region::new(region.clone()));
    }
    match (&config.aws_access_key_id, &config.aws_secret_access_key) {
        (Some(access), Some(secret)) => {
            loader = loader.credentials_provider(Credentials::new(
                access,
                secret,
                None,
                None,
                "boundless-storage",
            ));
        }
        (None, None) => {}
        _ => bail!("AWS access key and secret must be configured together"),
    }
    let client = Client::new(&loader.load().await);
    let response = client
        .get_public_access_block()
        .bucket(config.s3_bucket.as_deref().expect("validated S3 bucket"))
        .send()
        .await
        .context("Cannot verify witness bucket public-access blocking")?;
    validate_access_block(response.public_access_block_configuration())
}

fn validate_access_block(block: Option<&PublicAccessBlockConfiguration>) -> Result<()> {
    if !block.is_some_and(|block| {
        block.block_public_acls() == Some(true)
            && block.ignore_public_acls() == Some(true)
            && block.block_public_policy() == Some(true)
            && block.restrict_public_buckets() == Some(true)
    }) {
        bail!("All four S3 Block Public Access settings must be enabled for batch witnesses");
    }
    Ok(())
}

pub fn validate_input(input: &RequestInput, bucket: &str, digest: &str) -> Result<()> {
    if input.inputType != RequestInputType::Url {
        bail!("Batch witnesses must never be included inline in a Boundless request");
    }
    let url = Url::parse(std::str::from_utf8(&input.data).context("Invalid witness reference")?)?;
    if url.scheme() != "s3"
        || url.host_str() != Some(bucket)
        || url.path() != format!("/{digest}.input")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Boundless witness reference must identify the exact private S3 object without access tokens");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> StorageUploaderConfig {
        let mut config = StorageUploaderConfig::default();
        config.storage_uploader = StorageUploaderType::S3;
        config.s3_bucket = Some("pnlx-test-witnesses".into());
        config.s3_presigned = Some(false);
        config.s3_public_url = Some(false);
        config
    }

    #[test]
    fn requires_authenticated_storage_without_public_or_presigned_urls() {
        assert!(validate_config(&config()).is_ok());
        for provider in [
            StorageUploaderType::None,
            StorageUploaderType::Pinata,
            StorageUploaderType::File,
        ] {
            let mut config = config();
            config.storage_uploader = provider;
            assert!(validate_config(&config).is_err());
        }
        for presigned in [None, Some(true)] {
            let mut config = config();
            config.s3_presigned = presigned;
            assert!(validate_config(&config).is_err());
        }
        let mut public = config();
        public.s3_public_url = Some(true);
        assert!(validate_config(&public).is_err());
        let mut missing = config();
        missing.s3_bucket = None;
        assert!(validate_config(&missing).is_err());
        let mut endpoint = config();
        endpoint.s3_url = Some("https://storage.example".into());
        assert!(validate_config(&endpoint).is_err());
    }

    #[test]
    fn requires_every_public_access_block_setting() {
        assert!(validate_access_block(None).is_err());
        for omitted in 0..5 {
            let block = PublicAccessBlockConfiguration::builder()
                .block_public_acls(omitted != 0)
                .ignore_public_acls(omitted != 1)
                .block_public_policy(omitted != 2)
                .restrict_public_buckets(omitted != 3)
                .build();
            assert_eq!(validate_access_block(Some(&block)).is_ok(), omitted == 4);
        }
        assert!(
            validate_access_block(Some(&PublicAccessBlockConfiguration::builder().build()))
                .is_err()
        );
    }

    #[test]
    fn only_the_exact_tokenless_s3_witness_reference_can_be_submitted() {
        let bucket = "pnlx-test-witnesses";
        let digest = "a1".repeat(32);
        let valid = format!("s3://{bucket}/{digest}.input");
        assert!(validate_input(
            &RequestInput::url(Url::parse(&valid).unwrap()),
            bucket,
            &digest
        )
        .is_ok());
        assert!(validate_input(&RequestInput::inline(vec![1, 2, 3]), bucket, &digest).is_err());
        for url in [
            format!("https://{bucket}.s3.amazonaws.com/{digest}.input"),
            format!("https://example.com/ipfs/{digest}"),
            format!("s3://another-bucket/{digest}.input"),
            format!("s3://{bucket}/wrong.input"),
            format!("{valid}?X-Amz-Signature=token"),
            format!("{valid}#token"),
            format!("s3://token@{bucket}/{digest}.input"),
        ] {
            assert!(validate_input(
                &RequestInput::url(Url::parse(&url).unwrap()),
                bucket,
                &digest
            )
            .is_err());
        }
    }
}
