# R1 rejected candidate — exact review-only delivery

**NOT R3. NOT APPROVED. DO NOT APPLY OR DEPLOY.**

This directory preserves the already-existing R1 artifact. No candidate code
was repaired, regenerated, executed, or applied to the application.

## Read or download

- `CCC-ALPHA-B50-01-R1-BLOCKED.zip`: byte-for-byte copy of the original archive.
- `candidate-files/`: all five complete candidate files, with `.txt` appended
  to prevent normal TypeScript/test discovery. File contents are unchanged.
- `candidate-NOT-FOR-DEPLOYMENT.patch.txt`: original complete patch, unchanged.
- `RESULT.md.txt` and `MANIFEST.txt.txt`: original archived reports, unchanged.
- `delivery-manifest.json`: paths, sizes, and SHA-256 values linking every
  delivered file to its member in the original ZIP.

Use GitHub's Raw/Download controls on the file pages. Pin references to this
delivery commit rather than the moving branch. A future review should compare
the fetched bytes against `delivery-manifest.json`, not trust a completion
message or a file name alone.

## Identity and boundaries

- Candidate baseline: `8a0757ceb7130507e69e904395c491a58d80c3ec`.
- Original ZIP: 89,830 bytes.
- Original ZIP SHA-256:
  `3d9e363d32d2d61342432299db4b89e0beabf5942ac74e9aabe0daf9d723dbca`.
- Original patch: 39,221 bytes; SHA-256
  `b5a23386ae5e09f0aaf932a20850c1a4d4ef5c06ad6045d2cf6c6de9c22eeaa0`.

The historical R1 test report is included only as history. R1 failed its final
safety review. No new application tests, implementation, or readiness claims
are part of this delivery. The rejected candidate's proposed policy text is
also only evidence, not an amendment to the canonical policy.

All eight archived text members were checked before export for private-key
blocks, common credential/token formats, JWTs, credential-bearing URLs,
literal secret assignments, and database-dump markers. No matches were found.
This bounded check is not a guarantee of absence of every possible secret.
No runtime environment values, credentials, database data, or workspace dump
are included.

Attributable spend and remaining original cumulative $50 budget are UNKNOWN.
Consequently this task ends with source delivery only; it does not proceed to
candidate remediation. No deployment, app execution, financial activation,
operational data/configuration change, merge, rebase, force push, new branch,
or new PR is authorized or performed by this delivery.