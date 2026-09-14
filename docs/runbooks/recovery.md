# Isolated backup and recovery

This runbook is for approved development or preview recovery drills. The tools reject `production` and require an approval string bound to the exact environment and absolute target directory. They never create, overwrite, or delete a production resource.

1. Create a new, empty Supabase project for the drill. Record its project reference and have a second operator approve that isolated target.
2. Produce a read-only database dump and a private Storage export from the approved non-production source.

   **The dump must include the `auth` schema, not only `public` and `private`.** A 2026-09-13 drill dumped `--schema=public --schema=private` and the restore looked healthy — 29 tables, 122 functions, all rows present — while silently losing **18 of 23 RLS policies and 21 of 52 foreign keys**, because every policy calling `auth.uid()` and every constraint referencing `auth.users` failed to apply. Row-level security stays *enabled* on all 29 tables, so the damage does not surface as an error: the tables simply deny everything until someone "fixes" it by disabling RLS. Restoring a `public`+`private` dump into an empty project therefore produces a database that is **not** the one you backed up. If a scope is deliberately narrowed, record exactly which policies and constraints are expected to be missing, and re-check the counts below after restore.

   Verify after every restore, against the source:

   ```sql
   select (select count(*) from pg_policies where schemaname in ('public','private')) as policies,
          (select count(*) from pg_constraint co join pg_class c on c.oid = co.conrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public','private') and co.contype = 'f') as fkeys;
   ```

   The Storage export must include `inventory.json` with `objects`, active `references`, and `tombstones`. **`references` and `tombstones` must be mutually exclusive** — in Orincard both derive from the single `public.assets.state` column, so they are exclusive by construction; an adapter that lists a soft-deleted key in both would make the reference and tombstone checks pass vacuously. `verifyRestore` now asserts this. Never place credentials in the export or manifest.
3. Set `APP_ENV` to `development` or `preview`, `APPROVED_DATABASE_DUMP`, `APPROVED_STORAGE_EXPORT`, and `ISOLATED_TARGET_APPROVAL=APPROVED_ISOLATED_TARGET:<environment>:<absolute-output-directory>`. Run `node scripts/backup.mjs <absolute-output-directory>`.
4. Restore `database.dump` into the empty drill database, then upload every file under `storage/<bucket>/` to the matching private bucket. Do not point restore commands at an existing project.
5. Invoke `verifyRestore` from `scripts/restore-check.mjs` through the recovery harness with adapters for the isolated database and Storage project. It verifies the database dump hash, active references, every object hash, and that tombstoned objects were not restored.
6. Record only the manifest hash, counts, isolated project reference, operators, and timestamps. Do not copy source text, user content, object bytes, or credentials into logs or tickets.
7. Delete the isolated Supabase project through the approved provider workflow after evidence is retained. The scripts themselves perform no remote deletion.

A drill fails if any hash differs, an active reference is missing, a tombstone is resurrected, or the target approval does not match exactly. Stop and investigate the isolated copy; never retry against production.

## What these checks do and do not prove

- `databaseHashVerified` compares the dump file in the backup directory against the hash recorded in the same backup's manifest. It proves the **archive was not corrupted at rest**. It says nothing about whether the restored database matches the dump — the only evidence for that is the reference and tombstone comparison, plus the policy and foreign-key counts in step 2.
- `objectsVerified` hashes bytes fetched from the restored Storage against the manifest, so it does prove a byte-exact Storage restore.
- `assertIsolatedTarget` rejects any `APP_ENV` outside `development` and `preview`. It is the only production gate: the scripts receive externally supplied adapters and cannot see the Supabase project reference, so they cannot check `SUPABASE_PROJECT_REF != SUPABASE_PRODUCTION_PROJECT_REF` the way the CI guards do. **The operator remains responsible for pointing the adapters at a non-production project.**
- There is no runner for `verifyRestore` in this repository. It is a library; step 5 assumes an operator-written harness that supplies the two adapters.
