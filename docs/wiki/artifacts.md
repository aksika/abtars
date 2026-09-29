# Artifacts

abTARS can exchange task artifacts inline between agents and use an optional S3-compatible store for larger files.

## Inline artifacts

Workers can attach small files to a task result. The recipient can access them in the task workspace.

- Maximum file size: 1,000,000 bytes before base64 encoding.
- Request-size limits also apply, so the number of files that fit depends on their encoded size.
- Filenames are reduced to their base name before transfer.

## S3-compatible storage

For larger files, configure an S3-compatible endpoint and bucket in ~/.abtars/config/.env:

~~~bash
ARTIFACT_S3_ENDPOINT=https://storage.example.com
ARTIFACT_S3_BUCKET=abtars-artifacts
ARTIFACT_S3_REGION=auto
~~~

Store the access key and secret in abTARS's local credential storage. Do not put them in .env or share them with a task prompt. Use HTTPS with the storage provider.

The artifact tools are available when their configuration and required dependencies are present.

## When to use each

| Use case | Option |
|----------|--------|
| Small task input or result | Inline artifact |
| Large file or shared dataset | S3-compatible storage |
| Sensitive file | Keep it out of task payloads unless the destination and recipients are trusted |
