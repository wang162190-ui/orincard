# Isolated backup and recovery

This runbook is for approved development or preview recovery drills. The tools reject `production` and require an approval string bound to the exact environment and absolute target directory. They never create, overwrite, or delete a production resource.

1. Create a new, empty Supabase project for the drill. Record its project reference and have a second operator approve that isolated target.
2. Produce a read-only database dump and a private Storage export from the approved non-production source. The Storage export must include `inventory.json` with `objects`, active `references`, and `tombstones`. Never place credentials in the export or manifest.
3. Set `APP_ENV` to `development` or `preview`, `APPROVED_DATABASE_DUMP`, `APPROVED_STORAGE_EXPORT`, and `ISOLATED_TARGET_APPROVAL=APPROVED_ISOLATED_TARGET:<environment>:<absolute-output-directory>`. Run `node scripts/backup.mjs <absolute-output-directory>`.
4. Restore `database.dump` into the empty drill database, then upload every file under `storage/<bucket>/` to the matching private bucket. Do not point restore commands at an existing project.
5. Invoke `verifyRestore` from `scripts/restore-check.mjs` through the recovery harness with adapters for the isolated database and Storage project. It verifies the database dump hash, active references, every object hash, and that tombstoned objects were not restored.
6. Record only the manifest hash, counts, isolated project reference, operators, and timestamps. Do not copy source text, user content, object bytes, or credentials into logs or tickets.
7. Delete the isolated Supabase project through the approved provider workflow after evidence is retained. The scripts themselves perform no remote deletion.

A drill fails if any hash differs, an active reference is missing, a tombstone is resurrected, or the target approval does not match exactly. Stop and investigate the isolated copy; never retry against production.
