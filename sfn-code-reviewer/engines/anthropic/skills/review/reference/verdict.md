# Verdict

| Verdict | When | CI effect (default gate) |
|---|---|---|
| `fix_first` | any `blocker`, or any `major` with `confidence: confirmed` | build fails if a finding meets `gate.failOn` (default: blocker) |
| `needs_discussion` | no blockers, but a human decision is needed: contract choice, a repo missing from the estate, a live-DB check, a specialist that failed | passes; the PR summary asks the question |
| `ready` | none of the above | passes |

With **cross-model verification** the verdict is recomputed in code after the other provider's
decisions (same rules as above), and the reason lists what it rejected.

The **gate** is separate from the verdict and is applied by `gate.mjs`, after suppressions:
- `failOn: blocker | major | minor | none`;
- `blockOnPossible: false` → only `confirmed` findings can fail the build;
- `onReviewError: fail | warn` → what happens if the review itself breaks (bad JSON, timeout).
