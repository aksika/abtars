# Google Drive Backup

Weekly backup of `~/.backup-abtars/` zip + encrypted memory.db to Google Drive.

## Folder

- Drive folder: `abtars-backup` (ID: `1bz7Ao1LpYILs9BcazVtayw-14g2CvCkM`)

## Steps

1. Find the latest zip: `ls -t ~/.backup-abtars/abtars-*.zip | head -1`
2. Upload zip: `gws-cli drive upload <path> --folder 1bz7Ao1LpYILs9BcazVtayw-14g2CvCkM`
3. Upload encrypted DB: `gws-cli drive upload ~/.abtars/backup/memory.db.enc --folder 1bz7Ao1LpYILs9BcazVtayw-14g2CvCkM`
4. List files in folder: `gws-cli drive list --folder 1bz7Ao1LpYILs9BcazVtayw-14g2CvCkM`
5. Keep max 3 backups (3 zips + 3 .enc = 6 files). Delete oldest if more: `gws-cli drive delete <file-id>`
