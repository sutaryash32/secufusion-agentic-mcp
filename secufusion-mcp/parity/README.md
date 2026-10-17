# Client review parity: how to calibrate

The question is "can the reviewer independently produce the comments the client reviewer wrote, before seeing them?" This folder is the measurement, not the review.

## What counts as a MATCH
Per client comment: MATCH, PARTIAL or MISS. A comment is a MATCH only if **all four** hold:
1. the same entity is identified;
2. the same business consequence is derived (substantially equivalent);
3. the same unsupported state is identified;
4. the resulting review comment is materially equivalent.

Finding the dependency alone is not enough; finding the invariant alone is not enough. The judgment records how far the chain reached (dependency, invariant, consequence, unsupported state, comment): a chain that stopped before the comment is at most PARTIAL. Root cause, severity and remediation intent are scored beside these and reported as agreement among matches; they do not gate.

Every PARTIAL and MISS names the **step of the reasoning chain that failed** (entity discovery, field discovery, consumer discovery, capability derivation, lifecycle reasoning, authority reasoning, consequence derivation, review formulation) and **the smallest improvement** that would continue the chain. Without both it is refused. Nothing is added to the reviewer for a miss nobody has root-caused.

## What counts as a parity result
Only a run that is blind (attested, from an unseen pack), on a benchmark whose purpose is "parity" (the client's real comments, code from before the review). Anything else reports counts only, with the reason, and no percentages. STORY-1656 is a design-validation exercise: its answer key is reconstructed from work records, the reviewer had seen them, and the branches already contain the fixes.

## The unseen-story process
1. **Get the answer key** without letting it reach the reviewer. From Azure DevOps, run in your own terminal: `node parity/tools/ado-fetch.mjs --pr-url <pull request URL>` (it asks for anything missing). It prints counts and the **pre-review commit** (the last iteration before the first review comment), writes the comments to `.secufusion/parity/ado/*.client.json` and a comment-free `*.meta.json`.
2. **Build the input pack**: `prepare_unseen_pack` with the story's work items, the cutoff (when the review was received) and each repo at the pre-review commit. The pack holds requirements, decisions logged before the cutoff, the spec and the code at that commit, and nothing else. A repo without a commit is refused.
3. **Review ONLY the pack.** Derive findings as BLOCKING / NON-BLOCKING / QUESTION / REQUIRES_DECISION with the full reasoning chain.
4. **Seal**: `calibrate_review action=seal` with `input_pack` and the attestation (saw the client comments? saw post-review findings?). A run is blind only if the attestation is clean and the pack is valid.
5. **Reveal**: `calibrate_review action=reveal` with `client_comments_file` pointing at the `*.client.json`. Judge each comment (MATCH / PARTIAL / MISS) and root-cause every miss.
6. **Regress**: re-run the earlier benchmarks after any change; matched comments must stay matched.

## The Azure DevOps token
It is read-only (Code: Read, Work Items: Read), typed into a **hidden prompt** of the script, held in memory for that run only and discarded. It is not accepted as an argument, never written to disk, never printed, and never put in an error message. **Never paste it into the chat with the assistant:** the conversation transcript is stored on disk. If a token was pasted anywhere, revoke it. Nothing in this suite stores a token; if you want one kept, use your operating system's credential manager, not a file here.

## Not shipped
`parity/` is not in the npm package. It holds client review material: confirm the repository is private before pushing it.
