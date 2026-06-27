# Caio BRAIN Final Verification - 2026-06-27

Final F5 evidence for goal `caio-brain-v1-operational-20260627`, after F0-F4
were merged. This pass was live/read-only against the local Caio runtime at
`~/.openclaw/workspaces/caio-runtime`. Secrets, bearer tokens, full JIDs, and
large payloads were not copied into this record.

## Result

Overall result: PASS with one recorded non-500 diagnostic.

- Default standalone audit passed with `bash ~/.openclaw/tools/brain-runtime-audit.sh`; this covers the standard OpenClaw inventory/git path, not every gitignored file under the runtime tree.
- Cockpit backend read the real BRAIN runtime and returned HTTP 200 `status=ok`.
- `/caio` rendered the BRAIN tab in a browser smoke and showed the contract plus structured reads.
- Runtime hash/mtime fingerprints were identical before and after the smokes.
- WhatsApp/BRAIN regression tests passed.
- Diagnostic: the backend's embedded/direct audit invocation passes `--root ~/.openclaw/workspaces/caio-runtime`, which also scans gitignored `.dreams` data, and returned the recorded `AuditFailed` / `audit.status=error` diagnostic because legacy `.dreams/short-term-recall.json` entries contain unallowlisted Obsidian references. The BRAIN bridge itself still returned HTTP 200 `status=ok` and did not fall back to Obsidian/iCloud/active-memory/memory-wiki.

## Commands And Observations

### Runtime audit

Command:

```bash
test -f "$HOME/.openclaw/tools/brain-runtime-audit.sh"
bash "$HOME/.openclaw/tools/brain-runtime-audit.sh"
```

Observed:

```text
audit_script_exists=yes
brain-runtime-audit: OK
```

This default command is an audit of the standard OpenClaw inventory/git path.
It should not be read as proof that every gitignored file beneath
`~/.openclaw/workspaces/caio-runtime` is audit-clean.

Diagnostic reproduction for the embedded audit path:

```bash
bash "$HOME/.openclaw/tools/brain-runtime-audit.sh" \
  --root "$HOME/.openclaw/workspaces/caio-runtime"
```

The embedded/direct `--root` path scans the runtime root directly, including
gitignored `.dreams` data. Observed `AuditFailed` with exit `1`; first
sanitized error:

```text
ERROR: workspaces/caio-runtime/memory/.dreams/short-term-recall.json:246: denied Obsidian reference is not allowlisted
```

### Backend BRAIN smoke

Command:

```bash
AUTH_MODE=local \
LOCAL_AUTH_TOKEN="$LOCAL_AUTH_TOKEN" \
BASE_URL=http://localhost:8000 \
CAIO_BRAIN_AUDIT_SCRIPT_PATH="$HOME/.openclaw/tools/brain-runtime-audit.sh" \
make brain-smoke \
  BRAIN_SMOKE_ARGS="--runtime-dir $HOME/.openclaw/workspaces/caio-runtime --limit 8"
```

Observed:

```text
BRAIN smoke ok: /api/v1/caio/brain/summary status=ok
```

Direct status smoke used a temporary local backend on `127.0.0.1:8017` with
SQLite in `/tmp` and a disposable local bearer token. It did not use production
Postgres. Observed summary:

```text
BACKEND_STATUS http=200 status=ok error_class=None contract_runtime_truth=local-first reads=21 inventory=28 audit_status=error audit_available=True
BACKEND_FIRST_READ_SHAPE has_provenance=True provenance_store=caio-brain-runtime has_freshness=True freshness_status=observed
```

The `audit_status=error` is the embedded audit diagnostic described above; it
was not a backend 500.

### Browser smoke

Smoke setup:

- Reused an already-running Next dev server for this worktree at `127.0.0.1:3109`.
- Started a temporary backend at `127.0.0.1:8017`.
- Used Playwright CLI session `caio-brain-f5-clean2`.
- Routed browser API calls to the temporary backend and stubbed only
  `/api/v1/users/me` with a non-sensitive local profile to avoid writing auth
  onboarding state.

Observed browser summary:

```text
url=http://127.0.0.1:3109/caio
brainHttpStatus=200
brainStatus=ok
brainAuditStatus=error
hasBrainTab=true
hasContractText=true
hasStructuredReadText=true
hasAuditText=true
```

The only remaining console error was a local-auth hydration mismatch caused by
injecting the token into browser `sessionStorage` for the smoke. No BRAIN
request failed.

## Read-Only Runtime Proof

The runtime tree fingerprint was computed across all regular files using
relative path, size, mtime, and content SHA-256. The aggregate digest and the
sample files matched exactly before and after audit/backend/UI/pytest smokes.

```text
BEFORE files=1422 bytes=4005193 digest=8c9742e66a783c6cfcfcee36e93415d1f3ca5906d950753bc2ed7ad0783e9ab0 latest_mtime_utc=2026-06-27T22:19:38.642946+00:00
AFTER  files=1422 bytes=4005193 digest=8c9742e66a783c6cfcfcee36e93415d1f3ca5906d950753bc2ed7ad0783e9ab0 latest_mtime_utc=2026-06-27T22:19:38.642946+00:00
```

Sample hashes also matched:

| Path | Size | mtime_ns | sha256 |
| --- | ---: | ---: | --- |
| `BRAIN_RUNTIME.md` | 6399 | 1782514218992512713 | `f84d1a47358317744906140f697372ea5f2282d4fd012d5fd6c670ccd68b9aa1` |
| `ARCHITECTURE_OVERVIEW.md` | 5293 | 1782324340099050308 | `905155314497732ec6086226edbc1c1b101e39d2def9f328172fb5bb7597bad4` |
| `SOUL.md` | 4610 | 1782327020864799211 | `449ee34f919415bfc7d559cfe94092799920134ee61a5a417a3d897a903f1c0e` |
| `USER.md` | 807 | 1778089893000000000 | `a616a118506bc804786ba2a087c7ecc824b7c3f62568f72988ffb16e57dab4fd` |
| `memory/2026-06-26.md` | 979 | 1782517707276499917 | `3779f507fce0ce5a889ab850b2d3b87f5ceecc5c26688fa124d790b91623cd5e` |

`memory/main.sqlite` and `lcm.db` were absent in this runtime root during both
fingerprints.

## AI-First Invariant Evidence

In-process `/api/v1/caio/brain/status?limit=8` summary:

```text
BRAIN_PAYLOAD_INVARIANT http=200 status=ok contract_runtime_truth=local-first obsidian_source_allowed=False icloud_source_allowed=False markdown_role=readability-cache reads=21 inventory=28 all_reads_have_shape=True snippet_limit=1200 audit_status=error audit_exit_code=1
BRAIN_SNIPPET_BOUNDS reads=21 inventory=28 snippet_limit=1200 max_read_snippet_chars=1200 all_within_limit=True
```

Interpretation:

- Useful BRAIN reads were structured with `provenance` and `freshness`.
- Markdown was represented as bounded, redacted projection/cache snippets.
- Contract flags kept Obsidian and iCloud disallowed as sources of truth.
- No backend/UI fallback to Obsidian, iCloud, `active-memory`, or `memory-wiki`
  was observed.
- The embedded audit diagnostic above should be tracked as a cleanup item for
  legacy `.dreams` entries, not treated as a successful audit result.

## WhatsApp/BRAIN Regression

Command:

```bash
cd /Users/openclaw/caio-whatsapp
python3 -m pytest \
  webhook/tests/test_brain_runtime_contract.py \
  webhook/tests/test_brain_runtime_consumers_f3.py \
  webhook/tests/test_braindump_notes.py \
  webhook/tests/test_braindump_handler.py \
  webhook/tests/test_braindump_graduation.py \
  -q
```

Observed:

```text
37 passed in 0.12s
```

## Cleanup

- Temporary backend `127.0.0.1:8017` was shut down.
- Temporary Playwright sessions were closed.
- Generated `.playwright-cli/` artifacts and `/tmp/caio-cockpit-f5-20260627.sqlite` were removed.
- Preexisting Next dev server at `127.0.0.1:3109` was left untouched.
