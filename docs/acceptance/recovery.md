# T056 Recovery packages

Local verification covers bounded ZIP inspection, canonical path rejection, invalid document rejection, owner isolation, inspection-hash comparison, and confirmation-only project creation. The development Supabase migrations were applied on 2026-09-09.

The real development-cloud acceptance uploaded a ZIP recovery source with an embedded PNG, inspected it, confirmed it, and verified that the restored project used a new project ID, a new asset ID, and a new owner-scoped private Storage key. The downloaded restored bytes matched the package bytes. Test projects, records, and Storage objects were removed after the run. PDF inputs are accepted only when `qpdf` finds the exact `orincard-recovery.zip` attachment; ordinary PDFs are rejected.
